package dev.syncpeer.plugin.android

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build

class SyncpeerTransferJobService : JobService() {
  override fun onCreate() {
    super.onCreate()
    SyncpeerTransferNotifications.ensureChannel(this)
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
    val notification = SyncpeerTransferNotifications.build(
      this,
      "Syncpeer transfer",
      "$label: 0%",
      0,
      true,
      true,
    )

    setNotification(
      params,
      SyncpeerTransferConstants.NOTIFICATION_ID,
      notification,
      JOB_END_NOTIFICATION_POLICY_DETACH,
    )

    // The transfer itself remains owned by the shared TypeScript core. Keeping
    // this job active keeps the application process eligible while that core
    // transfer is running in the background.
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean = false
}
