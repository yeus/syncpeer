package dev.syncpeer.plugin.android

import android.content.Context

/** Stores only the encrypted connection request needed for a sticky service restart. */
class BackgroundSessionStore(context: Context) {
  private val secrets = VaultSecretStore(context.applicationContext)

  @Synchronized
  fun save(request: String) {
    require(request.isNotBlank() && request.length <= 4096) { "Background session request is invalid." }
    secrets.execute(PROFILE_ID, "save", request)
  }

  @Synchronized
  fun load(): String? = secrets.execute(PROFILE_ID, "load", null) as String?

  @Synchronized
  fun clear() {
    secrets.execute(PROFILE_ID, "remove", null)
  }

  private companion object {
    const val PROFILE_ID = "background-session"
  }
}
