package dev.syncpeer.plugin.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class SyncpeerTransferService : Service() {
  companion object {
    const val ACTION_STOP = SyncpeerTransferConstants.ACTION_STOP
    const val EXTRA_LABEL = SyncpeerTransferConstants.EXTRA_LABEL
    private const val CHANNEL_ID = SyncpeerTransferConstants.CHANNEL_ID
    private const val NOTIFICATION_ID = SyncpeerTransferConstants.NOTIFICATION_ID
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Syncpeer transfers",
        NotificationManager.IMPORTANCE_LOW,
      )
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(true)
      stopSelf()
      return START_NOT_STICKY
    }

    val label = intent?.getStringExtra(EXTRA_LABEL)?.trim().orEmpty().ifBlank { "File transfer" }
    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
      .setContentTitle("Syncpeer transfer")
      .setContentText(label)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .build()

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
