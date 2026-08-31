package dev.syncpeer.plugin.android

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class SyncpeerTransferService : Service() {
  companion object {
    const val ACTION_STOP = SyncpeerTransferConstants.ACTION_STOP
    const val EXTRA_LABEL = SyncpeerTransferConstants.EXTRA_LABEL
    private const val NOTIFICATION_ID = SyncpeerTransferConstants.NOTIFICATION_ID
  }

  override fun onCreate() {
    super.onCreate()
    SyncpeerTransferNotifications.ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(true)
      stopSelf()
      return START_NOT_STICKY
    }

    val label = intent?.getStringExtra(EXTRA_LABEL)?.trim().orEmpty().ifBlank { "File transfer" }
    val notification = SyncpeerTransferNotifications.build(
      this,
      "Syncpeer transfer",
      "$label: 0%",
      0,
      true,
      true,
    )

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
