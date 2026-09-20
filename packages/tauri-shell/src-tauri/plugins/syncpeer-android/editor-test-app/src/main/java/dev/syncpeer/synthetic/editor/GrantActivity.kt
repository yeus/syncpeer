package dev.syncpeer.synthetic.editor

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.DocumentsContract

class GrantActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
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
    finish()
  }
}
