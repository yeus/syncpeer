package dev.syncpeer.plugin.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

internal object SyncpeerSessionConstants {
  const val ACTION_START = "dev.syncpeer.plugin.android.START_SESSION_SERVICE"
  const val ACTION_STOP = "dev.syncpeer.plugin.android.STOP_SESSION_SERVICE"
  const val EXTRA_REQUEST = "dev.syncpeer.plugin.android.SESSION_REQUEST"
  const val CHANNEL_ID = "syncpeer-session-v1"
  const val NOTIFICATION_ID = 22068
}

internal object SyncpeerSessionNotifications {
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      SyncpeerSessionConstants.CHANNEL_ID,
      "Syncpeer background synchronization",
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.enableVibration(false)
    channel.setSound(null, null)
    channel.setShowBadge(false)
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  fun update(context: Context, title: String, body: String, ongoing: Boolean = true) {
    ensureChannel(context)
    context.getSystemService(NotificationManager::class.java).notify(
      SyncpeerSessionConstants.NOTIFICATION_ID,
      build(context, title, body, ongoing),
    )
  }

  fun cancel(context: Context) {
    context.getSystemService(NotificationManager::class.java)
      .cancel(SyncpeerSessionConstants.NOTIFICATION_ID)
  }

  fun build(context: Context, title: String, body: String, ongoing: Boolean): Notification {
    val builder = NotificationCompat.Builder(context, SyncpeerSessionConstants.CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(ongoing)
      .setAutoCancel(!ongoing)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    if (launchIntent != null) {
      launchIntent.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      builder.setContentIntent(pendingActivity(context, launchIntent))
    }
    return builder.build()
  }

  private fun pendingActivity(context: Context, intent: Intent): PendingIntent {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(context, SyncpeerSessionConstants.NOTIFICATION_ID, intent, flags)
  }
}
