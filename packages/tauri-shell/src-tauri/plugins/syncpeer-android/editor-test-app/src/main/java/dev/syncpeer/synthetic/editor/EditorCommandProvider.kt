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

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    val resolver = checkNotNull(context).contentResolver
    val tree = storedTree()
    val name = arg.orEmpty()
    val result = when (method) {
      "status" -> tree?.toString() ?: ""
      "create" -> {
        require(tree != null && validName(name)) { "A granted tree and safe file name are required" }
        check(findChild(tree, name) == null) { "Synthetic document already exists" }
        checkNotNull(DocumentsContract.createDocument(resolver, rootDocument(tree), "text/plain", name)).toString()
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
