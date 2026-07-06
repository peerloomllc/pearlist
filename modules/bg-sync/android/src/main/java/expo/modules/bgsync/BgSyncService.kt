package expo.modules.bgsync

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Foreground service that keeps the app process - and therefore the Bare worklet
// and its Hyperswarm connections - alive while PearList is backgrounded, so a
// household's Android device stays a reliable P2P sync/relay point and delivers
// assignment/join notifications in real time. Ported and simplified from
// PearGuard's ParentConnectionService. Android-only; iOS has no equivalent.
class BgSyncService : Service() {
  companion object {
    private const val CHANNEL_ID = "pearlist_sync"
    private const val NOTIF_ID = 4201
    const val EXTRA_WAKE_HOST = "wakeHost"
  }

  override fun onCreate() {
    super.onCreate()
    createChannel()
    startForeground(NOTIF_ID, buildNotification())
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Cold-started by the boot receiver or an OS restart (no Activity / JS host
    // running): bring the app up so index.tsx starts the worklet and rejoins the
    // swarm. A no-op on the normal path where JS itself started the service.
    if (intent?.getBooleanExtra(EXTRA_WAKE_HOST, false) == true) wakeHost()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // Swiping the app from recents kills the process on many OEMs; reschedule a
  // near-future restart so background sync resumes. A true force-stop / reinstall
  // cannot be revived until the user reopens the app.
  override fun onTaskRemoved(rootIntent: Intent?) {
    try {
      val restart = Intent(applicationContext, BgSyncService::class.java)
        .putExtra(EXTRA_WAKE_HOST, true)
      val pi = PendingIntent.getService(
        applicationContext, 1, restart,
        PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
      )
      val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
      am?.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 2000, pi)
    } catch (_: Exception) {}
    super.onTaskRemoved(rootIntent)
  }

  private fun wakeHost() {
    try {
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
      if (launch != null) startActivity(launch)
    } catch (_: Exception) {}
  }

  private fun buildNotification(): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val pi = if (open != null) {
      PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE)
    } else null
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("PearList")
      .setContentText("Keeping your lists in sync")
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .setContentIntent(pi)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(
        CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_LOW
      )
      ch.description = "Keeps your lists syncing peer-to-peer in the background"
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .createNotificationChannel(ch)
    }
  }
}
