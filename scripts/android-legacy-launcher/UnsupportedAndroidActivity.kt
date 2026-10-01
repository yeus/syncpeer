package dev.syncpeer.app

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

class UnsupportedAndroidActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val inset = (24 * resources.displayMetrics.density).toInt()
    setContentView(TextView(this).apply {
      text = "Syncpeer needs Android 8 or newer for document access. This Android version is unsupported."
      textSize = 18f
      gravity = Gravity.CENTER
      setPadding(inset, inset, inset, inset)
    })
  }
}
