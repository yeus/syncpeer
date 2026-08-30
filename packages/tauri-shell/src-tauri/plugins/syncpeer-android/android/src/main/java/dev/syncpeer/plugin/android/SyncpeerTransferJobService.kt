package dev.syncpeer.plugin.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Intent
import android.os.Build

internal object SyncpeerTransferConstants {
  const val ACTION_STOP = "dev.syncpeer.plugin.android.STOP_TRANSFER_SERVICE"
  const val EXTRA_LABEL = "dev.syncpeer.plugin.android.TRANSFER_LABEL"
  const val CHANNEL_ID = "syncpeer-transfers"
  const val NOTIFICATION_ID = 22067
  const val JOB_ID = 22067
}

class SyncpeerTransferJobService : JobService() {
  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        SyncpeerTransferConstants.CHANNEL_ID,
        "Syncpeer transfers",
        NotificationManager.IMPORTANCE_LOW,
      )
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onStartJob(params: JobParameters): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      jobFinished(params, false)
      return false
    }

    val label = params.extras
      .getString(SyncpeerTransferConstants.EXTRA_LABEL)
      ?.trim()
      .orEmpty()
      .ifBlank { "File transfer" }
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val notificationBuilder = Notification.Builder(this, SyncpeerTransferConstants.CHANNEL_ID)
      .setContentTitle("Syncpeer transfer")
      .setContentText(label)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setOngoing(true)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
    if (launchIntent != null) {
      notificationBuilder.setContentIntent(
        PendingIntent.getActivity(
          this,
          SyncpeerTransferConstants.NOTIFICATION_ID,
          launchIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    }
    val notification = notificationBuilder.build()

    setNotification(
      params,
      SyncpeerTransferConstants.NOTIFICATION_ID,
      notification,
      JOB_END_NOTIFICATION_POLICY_REMOVE,
    )

    // The transfer itself remains owned by the shared TypeScript core. Keeping
    // this job active keeps the application process eligible while that core
    // transfer is running in the background.
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean = false
}
