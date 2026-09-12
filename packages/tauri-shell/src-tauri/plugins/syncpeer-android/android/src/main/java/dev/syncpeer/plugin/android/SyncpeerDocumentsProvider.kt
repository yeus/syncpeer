package dev.syncpeer.plugin.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.database.Cursor
import android.database.MatrixCursor
import android.os.Build
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.os.IBinder
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.ProxyFileDescriptorCallback
import android.os.storage.StorageManager
import android.system.ErrnoException
import android.system.OsConstants
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import java.io.FileNotFoundException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONArray

class SyncpeerDocumentsProvider : DocumentsProvider() {
  @Volatile private var runtimeSummary = "Starting document access…"
  private var bound = false
  private var ready = CompletableFuture<DocumentRuntimeService.RuntimeBinder>()
  private val ioThread by lazy { HandlerThread("SyncpeerDocumentsIO").apply { start() } }
  @Volatile private var runtime: DocumentRuntimeService.RuntimeBinder? = null
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val owner = service as DocumentRuntimeService.RuntimeBinder
      runtime = owner
      ready.complete(owner)
      owner.status().thenAccept { status ->
        runtimeSummary = status.summary
        notifyRoots()
        if (status.phase == "locked") owner.command(JSONObject().put("operation", "status")).thenAccept {
          runtimeSummary = owner.status().getNow(status).summary
          notifyRoots()
        }
      }
    }
    override fun onServiceDisconnected(name: ComponentName) {
      runtime = null
      ready.completeExceptionally(FileNotFoundException("Document runtime disconnected."))
      runtimeSummary = "Document runtime stopped. Reopen Syncpeer to retry."
      notifyRoots()
    }
    override fun onNullBinding(name: ComponentName) = onServiceDisconnected(name)
    override fun onBindingDied(name: ComponentName) = onServiceDisconnected(name)
  }

  override fun onCreate(): Boolean = true

  @Synchronized private fun ensureRuntime() {
    if (bound || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val app = context?.applicationContext ?: return
    bound = app.bindService(Intent(app, DocumentRuntimeService::class.java), connection, Context.BIND_AUTO_CREATE)
    if (!bound) {
      runtimeSummary = "Document runtime could not start."
    }
  }

  @Synchronized override fun shutdown() {
    if (bound) context?.applicationContext?.unbindService(connection)
    bound = false
    if (runtime != null) ioThread.quitSafely()
    super.shutdown()
  }

  private fun notifyRoots() {
    val app = context ?: return
    app.contentResolver.notifyChange(DocumentsContract.buildRootsUri("${app.packageName}.documents"), null)
  }

  override fun queryRoots(projection: Array<out String>?): Cursor {
    ensureRuntime()
    val columns = projection ?: arrayOf(
      Root.COLUMN_ROOT_ID,
      Root.COLUMN_DOCUMENT_ID,
      Root.COLUMN_TITLE,
      Root.COLUMN_SUMMARY,
      Root.COLUMN_FLAGS,
      Root.COLUMN_MIME_TYPES,
      Root.COLUMN_AVAILABLE_BYTES,
      Root.COLUMN_ICON,
    )
    val cursor = MatrixCursor(columns)
    cursor.newRow().apply {
      add(Root.COLUMN_ROOT_ID, ROOT_ID)
      add(Root.COLUMN_DOCUMENT_ID, ROOT_DOCUMENT_ID)
      add(Root.COLUMN_TITLE, "Syncpeer")
      add(Root.COLUMN_SUMMARY, summary())
      add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_IS_CHILD)
      add(Root.COLUMN_MIME_TYPES, "*/*")
      add(Root.COLUMN_AVAILABLE_BYTES, null)
      add(Root.COLUMN_ICON, 0)
    }
    return cursor
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val cursor = MatrixCursor(documentColumns(projection))
    if (documentId == ROOT_DOCUMENT_ID) addRootDocument(cursor)
    else addDocument(cursor, command(JSONObject().put("operation", "stat").put("id", documentId)) as JSONObject)
    return cursor
  }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val cursor = MatrixCursor(documentColumns(projection))
    val values = command(JSONObject().put("operation", "list").put("id", parentDocumentId)) as JSONArray
    for (index in 0 until values.length()) addDocument(cursor, values.getJSONObject(index))
    cursor.setNotificationUri(context!!.contentResolver, DocumentsContract.buildRootsUri("${context!!.packageName}.documents"))
    return cursor
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
    if (documentId == ROOT_DOCUMENT_ID) return false
    command(JSONObject().put("operation", "stat").put("id", documentId))
    if (parentDocumentId == ROOT_DOCUMENT_ID) return true
    val parentInfo = command(JSONObject().put("operation", "stat").put("id", parentDocumentId)) as JSONObject
    if (!parentInfo.getBoolean("directory")) return false
    val parent = JSONArray(parentDocumentId)
    val child = JSONArray(documentId)
    return parent.getString(0) == child.getString(0) &&
      child.getString(1).startsWith(parent.getString(1).let { if (it.isEmpty()) "" else "$it/" }) && parentDocumentId != documentId
  }

  override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
    val result = command(JSONObject().put("operation", "create").put("id", parentDocumentId)
      .put("name", displayName).put("directory", mimeType == Document.MIME_TYPE_DIR)) as JSONObject
    return result.getString("id")
  }

  /** Configuration is private to Syncpeer; a document URI grant never grants vault control. */
  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    if (method != "syncpeerDocumentCommand") return super.call(method, arg, extras)
    check(Binder.getCallingUid() == context!!.applicationInfo.uid) { "Vault control is private to Syncpeer." }
    val result = command(JSONObject(checkNotNull(arg)))
    return Bundle().apply { putString("result", JSONObject().put("result", result ?: JSONObject.NULL).toString()) }
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    signal?.throwIfCanceled()
    if (Build.VERSION.SDK_INT < 26) throw FileNotFoundException(summary())
    val handle = (command(JSONObject().put("operation", "open").put("id", documentId).put("mode", mode)) as Number).toInt()
    val callback = object : ProxyFileDescriptorCallback() {
      private var released = false
      private fun request(operation: String, offset: Long = 0, size: Int = 0, data: ByteArray? = null): Any? {
        try {
          signal?.throwIfCanceled()
          val input = JSONObject().put("operation", operation).put("handle", handle).put("offset", offset).put("size", size)
          if (data != null) input.put("bytes", JSONArray(data.take(size).map { it.toInt() and 255 }))
          return command(input)
        } catch (_: Exception) { throw ErrnoException(operation, OsConstants.EIO) }
      }
      override fun onGetSize(): Long = (request("size") as Number).toLong()
      override fun onRead(offset: Long, size: Int, data: ByteArray): Int {
        val bytes = request("read", offset, minOf(size, 131072)) as JSONArray
        for (index in 0 until bytes.length()) data[index] = bytes.getInt(index).toByte()
        return bytes.length()
      }
      override fun onWrite(offset: Long, size: Int, data: ByteArray): Int {
        // Core durably journals encrypted changed blocks before acknowledging this write.
        // Whole-file publication is deferred to fsync/close and recovered after process death.
        return (request("write", offset, minOf(size, 131072), data) as Number).toInt()
      }
      override fun onFsync() { request("flush") }
      override fun onRelease() {
        if (released) return
        released = true
        runCatching { command(JSONObject().put("operation", "release").put("handle", handle)) }
      }
    }
    try {
      // Truncation is already durable in the core journal.
      val manager = context!!.getSystemService(Context.STORAGE_SERVICE) as StorageManager
      return manager.openProxyFileDescriptor(ParcelFileDescriptor.parseMode(mode), callback, Handler(ioThread.looper))
    } catch (error: Exception) {
      command(JSONObject().put("operation", "release").put("handle", handle).put("abort", true))
      throw error
    }
  }

  private fun command(input: JSONObject): Any? {
    ensureRuntime()
    if (Build.VERSION.SDK_INT < 26 || !bound) throw FileNotFoundException(summary())
    try { return ready.get(30, TimeUnit.SECONDS).command(input).get().opt("result").takeUnless { it == JSONObject.NULL } }
    catch (_: Exception) { throw FileNotFoundException("Document operation failed. Check Folder settings in Syncpeer.") }
  }

  private fun addDocument(cursor: MatrixCursor, value: JSONObject) {
    val directory = value.getBoolean("directory")
    cursor.newRow().apply {
      add(Document.COLUMN_DOCUMENT_ID, value.getString("id"))
      add(Document.COLUMN_DISPLAY_NAME, value.getString("name"))
      add(Document.COLUMN_MIME_TYPE, if (directory) Document.MIME_TYPE_DIR else "application/octet-stream")
      add(Document.COLUMN_FLAGS, if (directory) Document.FLAG_DIR_SUPPORTS_CREATE else Document.FLAG_SUPPORTS_WRITE)
      add(Document.COLUMN_SIZE, if (directory) null else value.getLong("size"))
      add(Document.COLUMN_LAST_MODIFIED, value.getLong("modifiedMs"))
      add(Document.COLUMN_SUMMARY, null)
    }
  }

  private fun addRootDocument(cursor: MatrixCursor) {
    cursor.newRow().apply {
      add(Document.COLUMN_DOCUMENT_ID, ROOT_DOCUMENT_ID)
      add(Document.COLUMN_DISPLAY_NAME, "Syncpeer")
      add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
      add(Document.COLUMN_FLAGS, 0)
      add(Document.COLUMN_SIZE, null)
      add(Document.COLUMN_LAST_MODIFIED, 0)
      add(Document.COLUMN_SUMMARY, summary())
    }
  }

  private fun documentColumns(projection: Array<out String>?) = projection ?: arrayOf(
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_FLAGS,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED,
    Document.COLUMN_SUMMARY,
  )

  private fun summary(): String = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
    "Android document access requires API 26 or newer."
  } else {
    runtime?.status()?.getNow(null)?.summary ?: runtimeSummary
  }

  companion object {
    private const val ROOT_ID = "syncpeer"
    private const val ROOT_DOCUMENT_ID = "syncpeer-root"
  }
}
