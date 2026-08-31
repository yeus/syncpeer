package dev.syncpeer.plugin.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

internal object SyncpeerTransferConstants {
  const val ACTION_STOP = "dev.syncpeer.plugin.android.STOP_TRANSFER_SERVICE"
  const val ACTION_CANCEL = "dev.syncpeer.plugin.android.CANCEL_TRANSFER"
  const val EVENT_TRANSFER_ACTION = "transferAction"
  const val EXTRA_LABEL = "dev.syncpeer.plugin.android.TRANSFER_LABEL"
  const val CHANNEL_ID = "syncpeer-transfers-v2"
  const val NOTIFICATION_ID = 22067
  const val JOB_ID = 22067
}

internal object SyncpeerTransferNotifications {
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      SyncpeerTransferConstants.CHANNEL_ID,
      "Syncpeer transfers",
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.enableVibration(false)
    channel.setSound(null, null)
    channel.setShowBadge(false)
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  fun update(
    context: Context,
    title: String,
    body: String,
    progress: Int?,
    ongoing: Boolean,
    cancellable: Boolean,
  ) {
    ensureChannel(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.notify(
      SyncpeerTransferConstants.NOTIFICATION_ID,
      build(context, title, body, progress, ongoing, cancellable),
    )
  }

  fun build(
    context: Context,
    title: String,
    body: String,
    progress: Int?,
    ongoing: Boolean,
    cancellable: Boolean,
  ): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationCompat.Builder(context, SyncpeerTransferConstants.CHANNEL_ID)
    } else {
      NotificationCompat.Builder(context)
    }
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setOngoing(ongoing)
      .setAutoCancel(!ongoing)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setProgress(
        100,
        progress?.coerceIn(0, 100) ?: 0,
        progress == null,
      )

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    if (launchIntent != null) {
      launchIntent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      builder.setContentIntent(pendingActivity(context, launchIntent, SyncpeerTransferConstants.NOTIFICATION_ID))
      if (cancellable) {
        val cancelIntent = Intent(launchIntent).apply {
          action = SyncpeerTransferConstants.ACTION_CANCEL
        }
        builder.addAction(
          android.R.drawable.ic_menu_close_clear_cancel,
          "Cancel",
          pendingActivity(context, cancelIntent, SyncpeerTransferConstants.NOTIFICATION_ID + 1),
        )
      }
    }
    return builder.build()
  }

  private fun pendingActivity(context: Context, intent: Intent, requestCode: Int): PendingIntent {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags = flags or PendingIntent.FLAG_IMMUTABLE
    }
    return PendingIntent.getActivity(context, requestCode, intent, flags)
  }
}
