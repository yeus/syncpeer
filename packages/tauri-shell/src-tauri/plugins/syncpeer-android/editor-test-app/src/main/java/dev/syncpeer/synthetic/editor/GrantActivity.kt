package dev.syncpeer.synthetic.editor

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.DocumentsContract

class GrantActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    if (intent.action == Intent.ACTION_VIEW) {
      // Only this disposable editor accepts a synthetic edit of a Syncpeer URI.
      val uri = intent.data
      Thread {
        val result = runCatching {
          check(uri?.authority == "dev.syncpeer.app.documents")
          check(intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
          val source = checkNotNull(uri)
          contentResolver.openInputStream(source)!!.use { check(it.read() >= 0) }
          contentResolver.openFileDescriptor(source, "rwt")!!.use { descriptor ->
            java.io.FileOutputStream(descriptor.fileDescriptor).use { output ->
              output.write("edited-from-syncpeer".toByteArray())
              output.fd.sync()
            }
          }
          contentResolver.openInputStream(source)!!.use {
            check(it.readBytes().contentEquals("edited-from-syncpeer".toByteArray()))
          }
          "ok"
        }.getOrElse { "error:${it.javaClass.simpleName}" }
        getSharedPreferences("editor", MODE_PRIVATE).edit().putString("opened", result).commit()
        runOnUiThread { finish() }
      }.start()
      return
    }
    if (state == null && intent.getBooleanExtra("saveAs", false)) {
      startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType("text/plain").putExtra(Intent.EXTRA_TITLE, "save-as-fixture.txt"), 2)
      return
    }
    if (state == null) {
      startActivityForResult(
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
          .putExtra(
            DocumentsContract.EXTRA_INITIAL_URI,
            DocumentsContract.buildRootUri(
              "dev.syncpeer.app.documents",
              "syncpeer",
            ),
          )
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
          .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
          .addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION),
        1,
      )
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    val uri = data?.data
    if (requestCode == 1 && resultCode == RESULT_OK && uri != null) {
      val flags = (data.flags and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
      contentResolver.takePersistableUriPermission(uri, flags)
      getSharedPreferences("editor", MODE_PRIVATE).edit().putString("tree", uri.toString()).commit()
    }
    if (requestCode == 2 && resultCode == RESULT_OK && uri != null) {
      // Write outside the Activity thread: SAF publication may take time.
      Thread {
        val result = runCatching {
          contentResolver.openOutputStream(uri, "wt")!!.use { it.write("saved-from-picker".toByteArray()) }
          contentResolver.openInputStream(uri)!!.use {
            check(it.readBytes().contentEquals("saved-from-picker".toByteArray()))
          }
          uri.toString()
        }.getOrElse { "error:${it.javaClass.simpleName}" }
        getSharedPreferences("editor", MODE_PRIVATE).edit().putString("saved", result).commit()
        runOnUiThread { finish() }
      }.start()
      return
    }
    finish()
  }
}
