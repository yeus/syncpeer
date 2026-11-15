package dev.syncpeer.plugin.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Keystore-encrypted, atomic job journal; never stored in plaintext preferences.
 * Attempts are epochs: late callbacks from an earlier attempt cannot publish
 * status or overwrite a completed/cancelled job. */
internal class TransferJobStore(context: Context, private val profileId: String = PROFILE_ID) {
  private val secrets = VaultSecretStore(context.applicationContext)

  @Synchronized fun list(): List<JSONObject> {
    val encoded = secrets.execute(profileId, "load", null) as String? ?: return emptyList()
    val array = JSONArray(encoded)
    require(array.length() <= MAX_JOBS) { "Invalid transfer job journal." }
    return (0 until array.length()).map { JSONObject(array.getJSONObject(it).toString()) }
  }

  @Synchronized private fun save(jobs: List<JSONObject>) {
    val encoded = JSONArray(jobs).toString()
    require(encoded.length <= MAX_BYTES) { "Transfer job journal is full." }
    if (jobs.isEmpty()) secrets.execute(profileId, "remove", null)
    else secrets.execute(profileId, "save", encoded)
  }

  @Synchronized fun enqueue(direction: String, folderId: String, path: String,
    peerId: String, stage: Map<String, Any>? = null): JSONObject {
    require(direction == "download" || direction == "upload") { "Invalid transfer direction." }
    require(folderId.isNotBlank() && folderId.length <= 512 && path.isNotBlank() && path.length <= 4096 &&
      !path.startsWith("/") && !path.contains("\\") &&
      !path.split("/").any { it == "." || it == ".." || it.isBlank() || it.startsWith(".syncpeer-") }) {
      "Invalid transfer target."
    }
    val recipient = peerId.replace("-", "").uppercase()
    require(recipient.matches(Regex("[A-Z2-7]{52}|[A-Z2-7]{56}"))) {
      "An authenticated destination peer is required."
    }
    if (stage != null) {
      require(direction == "upload" && stage["stageId"] is String &&
        (stage["stageId"] as String).matches(Regex("[a-f0-9-]{36}")) &&
        (stage["sizeBytes"] as? Long)?.let { it >= 0 && it <= 512L * 1024 * 1024 } == true &&
        (stage["modifiedMs"] as? Long)?.let { it >= 0 } == true &&
        (stage["sha256"] as? String)?.matches(Regex("[a-f0-9]{64}")) == true) {
        "Invalid encrypted staging metadata."
      }
    }
    val jobs = list().toMutableList()
    val duplicate = jobs.find { it.optString("direction") == direction && it.optString("folderId") == folderId &&
      it.optString("path") == path && it.optString("peerId") == recipient &&
      it.optString("phase") !in TERMINAL }
    if (duplicate != null) {
      require(stage == null || duplicate.optString("stageId") == stage["stageId"]) {
        "An upload for this target is already queued; cancel it before replacing the source."
      }
      return JSONObject(duplicate.toString())
    }
    if (jobs.size >= MAX_JOBS) {
      jobs.removeAll { it.optString("phase") in TERMINAL }
      require(jobs.size < MAX_JOBS) { "Finish or cancel existing transfers first." }
    }
    val created = JSONObject().put("id", UUID.randomUUID().toString())
      .put("direction", direction).put("folderId", folderId).put("path", path)
      .put("peerId", recipient)
      .put("phase", "queued").put("attempts", 0).put("nextAttemptMs", 0)
      .put("transferredBytes", 0).put("totalBytes", 0)
      .put("updatedAtMs", System.currentTimeMillis())
    stage?.forEach { (key, value) -> created.put(key, value) }
    jobs.add(created)
    save(jobs)
    return JSONObject(created.toString())
  }

  /** Transient network failures become delayed pending intents until the bounded
   * retry budget is exhausted. Other errors remain visible terminal failures. */
  @Synchronized fun progress(id: String, phase: String, transferredBytes: Long, totalBytes: Long,
    reason: String? = null, attempt: Int = 0): JSONObject? {
    require(phase in PHASES && transferredBytes >= 0 && totalBytes >= 0 &&
      transferredBytes <= totalBytes && reason in REASONS) { "Invalid transfer progress." }
    val jobs = list().toMutableList()
    val index = jobs.indexOfFirst { it.optString("id") == id }
    if (index < 0) return null
    val current = jobs[index]
    if (current.optString("phase") in TERMINAL || current.optInt("attempts") != attempt) return current
    if (phase == "running" && current.optString("phase") == "running" &&
      transferredBytes <= current.optLong("transferredBytes") &&
      totalBytes == current.optLong("totalBytes")) return current
    val now = System.currentTimeMillis()
    val updated = JSONObject(current.toString()).put("updatedAtMs", now)
    val retry = if (phase == "failed") TransferJobRetryPolicy.nextDelayMs(reason, attempt) else null
    if (retry != null) {
      updated.put("phase", "queued").put("attempts", attempt + 1)
        .put("nextAttemptMs", now + retry).put("transferredBytes", 0)
        .put("totalBytes", totalBytes).put("reason", "network")
    } else {
      updated.put("phase", phase).put("transferredBytes", transferredBytes)
        .put("totalBytes", totalBytes)
      if (phase == "running") {
        updated.remove("reason")
        updated.put("nextAttemptMs", 0)
      } else if (reason != null) updated.put("reason", reason)
    }
    jobs[index] = updated
    save(jobs)
    return updated
  }

  @Synchronized fun cancel(id: String): JSONObject? {
    val current = list().find { it.optString("id") == id } ?: return null
    return progress(id, "cancelled", current.optLong("transferredBytes"),
      current.optLong("totalBytes"), "cancelled", current.optInt("attempts"))
  }

  @Synchronized fun pending(): List<JSONObject> = list().filter {
    it.optString("phase") in setOf("queued", "running")
  }

  @Synchronized fun referencedStages(): Set<String> =
    list().filter { it.optString("phase") in setOf("queued", "running") }
      .mapNotNull { it.optString("stageId").takeIf(String::isNotBlank) }.toSet()

  private companion object {
    const val PROFILE_ID = "transfer-jobs"
    const val MAX_JOBS = 32
    const val MAX_BYTES = 15000
    val TERMINAL = setOf("completed", "failed", "cancelled")
    val PHASES = TERMINAL + setOf("queued", "running")
    val REASONS = setOf(null, "network", "storage", "cancelled", "unavailable", "other")
  }
}
