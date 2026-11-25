package dev.syncpeer.synthetic.editor

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.security.MessageDigest

class EditorCommandProvider : ContentProvider() {
  override fun onCreate(): Boolean = true
  // Test-only: hold the descriptor across the command response, deliberately
  // omitting fsync and close until the harness kills the document runtime.
  private var interruptedWriter: android.os.ParcelFileDescriptor.AutoCloseOutputStream? = null

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    val resolver = checkNotNull(context).contentResolver
    val tree = storedTree()
    val name = arg.orEmpty()
    val result = when (method) {
      "status" -> tree?.toString() ?: ""
      "probeVideoDecoder" -> {
        val bytes = android.util.Base64.decode(checkNotNull(extras?.getString("fixture")), android.util.Base64.DEFAULT)
        check(bytes.size in 1..1_048_576) { "Unexpected synthetic fixture size" }
        val reference = java.io.File.createTempFile("synthetic-video-", ".mp4", context!!.cacheDir)
        val started = android.os.SystemClock.elapsedRealtime()
        try {
          reference.writeBytes(bytes)
          android.os.ParcelFileDescriptor.open(reference, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
            .use { decodeVideoDescriptor(it) }
          "3:${android.os.SystemClock.elapsedRealtime() - started}"
        } finally { reference.delete() }
      }
      "saved", "opened" -> context!!.getSharedPreferences("editor", android.content.Context.MODE_PRIVATE)
        .getString(method, "").orEmpty()
      "create" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        check(findChild(tree, name) == null) { "Synthetic document already exists" }
        val mimeType = extras?.getString("mimeType") ?: "text/plain"
        checkNotNull(DocumentsContract.createDocument(resolver, rootDocument(tree), mimeType, name)).toString()
      }
      "write" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic document is missing" }
        val content = extras?.getString("content") ?: error("Synthetic content is required")
        require(content.toByteArray().size <= 65_536) { "Synthetic content is too large" }
        resolver.openFileDescriptor(document, "rwt")!!.use { descriptor ->
          FileOutputStream(descriptor.fileDescriptor).use { output ->
            output.write(content.toByteArray(Charsets.UTF_8))
            output.flush()
            output.fd.sync()
          }
        }
        content
      }
      "holdTruncatedWrite" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        check(name.endsWith(".kdbx") && interruptedWriter == null)
        val document = checkNotNull(findChild(tree, name))
        val payload = android.util.Base64.decode(extras?.getString("fixture").orEmpty(), android.util.Base64.DEFAULT)
        require(payload.size <= 32768)
        val output = android.os.ParcelFileDescriptor.AutoCloseOutputStream(
          checkNotNull(resolver.openFileDescriptor(document, "rwt")))
        interruptedWriter = output
        output.write(payload)
        payload.size.toString()
      }
      "listNames" -> {
        require(tree != null) { "A granted tree is required" }
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        checkNotNull(resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
          null, null, null)).use { cursor ->
          generateSequence { if (cursor.moveToNext()) cursor.getString(0) else null }.joinToString("|")
        }
      }
      "read" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic document is missing" }
        resolver.openInputStream(document)!!.use { input ->
          val output = ByteArrayOutputStream()
          val buffer = ByteArray(8_192)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            check(output.size() + count <= 65_536) { "Synthetic document is too large" }
            output.write(buffer, 0, count)
          }
          String(output.toByteArray(), Charsets.UTF_8)
        }
      }
      "rename" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val target = extras?.getString("target") ?: error("Synthetic target name is required")
        require(validName(target)) { "Synthetic target name is invalid" }
        check(findChild(tree, target) == null) { "Synthetic target already exists" }
        checkNotNull(DocumentsContract.renameDocument(
          resolver,
          checkNotNull(findChild(tree, name)) { "Synthetic document is missing" },
          target,
        )).toString()
      }
      "delete" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        DocumentsContract.deleteDocument(
          resolver,
          checkNotNull(findChild(tree, name)) { "Synthetic document is missing" },
        ).toString()
      }
      "stat" -> (tree != null && validName(name) && findChild(tree, name) != null).toString()
      "mimeTypes" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic document is missing" }
        val typeColumn = DocumentsContract.Document.COLUMN_MIME_TYPE
        val nameColumn = DocumentsContract.Document.COLUMN_DISPLAY_NAME
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val listedType = checkNotNull(resolver.query(children, arrayOf(nameColumn, typeColumn), null, null, null)).use { cursor ->
          generateSequence { if (cursor.moveToNext()) cursor.getString(0) to cursor.getString(1) else null }
            .first { it.first == name }.second
        }
        val queriedType = checkNotNull(resolver.query(document, arrayOf(typeColumn), null, null, null)).use { cursor ->
          check(cursor.moveToFirst())
          cursor.getString(0)
        }
        listOf(listedType, queriedType, resolver.getType(document)).joinToString("|")
      }
      "decodeVideo", "decodeVideoReference" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic video is missing" }
        val started = android.os.SystemClock.elapsedRealtime()
        if (method == "decodeVideoReference") {
          // Diagnostic control only: compare the same synthetic bytes on a
          // regular local file. Never treat this as a successful SAF decode.
          val reference = java.io.File.createTempFile("synthetic-video-", ".mp4", context!!.cacheDir)
          try {
            resolver.openFileDescriptor(document, "r")!!.use { descriptor ->
              val size = descriptor.statSize
              check(size in 1L..1_048_576L) { "Unexpected synthetic reference size: $size" }
              java.io.FileInputStream(descriptor.fileDescriptor).use { input ->
                reference.outputStream().use { output -> check(input.copyTo(output) == size) }
              }
            }
            android.os.ParcelFileDescriptor.open(reference, android.os.ParcelFileDescriptor.MODE_READ_ONLY)
              .use { decodeVideoDescriptor(it) }
          } finally { reference.delete() }
        } else {
          resolver.openFileDescriptor(document, "r")!!.use { decodeVideoDescriptor(it) }
        }
        "3:${android.os.SystemClock.elapsedRealtime() - started}"
      }
      "holdVideo" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic video is missing" }
        val started = android.os.SystemClock.elapsedRealtime()
        var frames = 0
        var maxReadMs = 0L
        val retriever = android.media.MediaMetadataRetriever()
        try {
          resolver.openFileDescriptor(document, "r")!!.use { descriptor ->
            val length = descriptor.statSize
            check(length > 0) { "Synthetic video descriptor has invalid length: $length" }
            retriever.setDataSource(descriptor.fileDescriptor, 0L, length)
            val buffer = ByteArray(16)
            while (android.os.SystemClock.elapsedRealtime() - started < 105_000L) {
              val readStarted = android.os.SystemClock.elapsedRealtime()
              // Native pread forces a real proxy read even if the decoder cached the tiny fixture.
              check(android.system.Os.pread(descriptor.fileDescriptor, buffer, 0, buffer.size, 0L) == buffer.size)
              maxReadMs = maxOf(maxReadMs, android.os.SystemClock.elapsedRealtime() - readStarted)
              val frame = checkNotNull(retriever.getFrameAtTime((frames % 2) * 1_000_000L,
                android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)) {
                "Decoder returned no video frame after $frames successful frames"
              }
              try { check(frame.width == 64 && frame.height == 64) }
              finally { frame.recycle() }
              frames++
              android.os.SystemClock.sleep(4_000L)
            }
          }
        } finally { retriever.release() }
        "$frames:${android.os.SystemClock.elapsedRealtime() - started}:$maxReadMs"
      }
      "digest" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        val document = checkNotNull(findChild(tree, name)) { "Synthetic document is missing" }
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        resolver.openInputStream(document)!!.use { input ->
          val buffer = ByteArray(131_072)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
            size += count
          }
        }
        "$size:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }}"
      }
      else -> error("Unknown synthetic editor command")
    }
    return Bundle().apply { putString("result", result) }
  }

  private fun decodeVideoDescriptor(descriptor: android.os.ParcelFileDescriptor) {
    val length = descriptor.statSize
    check(length > 0) { "Synthetic video descriptor has invalid length: $length" }
    val retriever = android.media.MediaMetadataRetriever()
    try {
      retriever.setDataSource(descriptor.fileDescriptor, 0L, length)
      val duration = checkNotNull(retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)) {
        "Synthetic video duration is missing (descriptor length=$length)"
      }.toLong()
      check(duration >= 1500) { "Synthetic video duration is invalid: $duration" }
      for (time in listOf(0L, 1_000_000L, 500_000L)) {
        val frame = checkNotNull(retriever.getFrameAtTime(time, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)) {
          "Decoder returned no video frame at ${time}us (descriptor length=$length, duration=$duration)"
        }
        try { check(frame.width == 64 && frame.height == 64) { "Invalid decoded frame: ${frame.width}x${frame.height}" } }
        finally { frame.recycle() }
      }
    } finally { retriever.release() }
  }

  private fun storedTree(): Uri? = checkNotNull(context)
    .getSharedPreferences("editor", android.content.Context.MODE_PRIVATE)
    .getString("tree", null)?.let(Uri::parse)

  private fun rootDocument(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(
    tree,
    DocumentsContract.getTreeDocumentId(tree),
  )

  private fun findChild(tree: Uri, name: String): Uri? {
    val parent = DocumentsContract.getTreeDocumentId(tree)
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    )
    checkNotNull(context).contentResolver.query(children, projection, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        if (cursor.getString(1) == name) {
          return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
        }
      }
    }
    return null
  }

  private fun validName(name: String): Boolean =
    name.isNotBlank() && name.length <= 128 && '/' !in name && '\u0000' !in name && name !in listOf(".", "..")

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?,
    selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?,
    selectionArgs: Array<out String>?): Int = 0
}
