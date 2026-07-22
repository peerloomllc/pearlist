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
import android.util.Log
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
    private const val TAG = "BgSyncService"
  }

  // False once the dataSync budget is spent (see tryStartForeground). Gates every
  // path that would otherwise walk back into the same throw.
  private var foregrounded = false

  override fun onCreate() {
    super.onCreate()
    createChannel()
    foregrounded = tryStartForeground()
    // Could not go foreground: stop quietly rather than let the throw escape as
    // "Unable to create service BgSyncService". Stopping promptly is also what
    // keeps the startForegroundService() contract - the system only complains if
    // we neither go foreground nor stop.
    if (!foregrounded) stopSelf()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Never went foreground: START_NOT_STICKY so the system does not keep
    // recreating us straight back into the same exception. START_STICKY here was
    // a crash loop - every restart re-entered onCreate with the budget still spent.
    if (!foregrounded) return START_NOT_STICKY
    // Cold-started by the boot receiver or an OS restart (no Activity / JS host
    // running): bring the app up so index.tsx starts the worklet and rejoins the
    // swarm. A no-op on the normal path where JS itself started the service.
    if (intent?.getBooleanExtra(EXTRA_WAKE_HOST, false) == true) wakeHost()
    return START_STICKY
  }

  // Android 15 (API 35) caps dataSync foreground services at 6 hours per 24, and
  // signals the end of the budget here. We MUST stop within a few seconds or the
  // system escalates to RemoteServiceException "a foreground service of type
  // dataSync did not stop within its timeout". The budget resets when the user
  // next brings the app to the foreground, and index.tsx re-arms on that.
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.i(TAG, "dataSync budget exhausted (onTimeout); stopping")
    foregrounded = false
    stopSelf()
  }

  // API 34's single-argument form. Only fires for shortService today, so it is
  // belt-and-braces, but an unhandled timeout is a crash and the body is one line.
  override fun onTimeout(startId: Int) {
    Log.i(TAG, "foreground service timeout (legacy callback); stopping")
    foregrounded = false
    stopSelf()
  }

  // Android 15+ throws ForegroundServiceStartNotAllowedException here once the
  // app has spent its 6h/24h dataSync allowance ("Time limit already exhausted
  // for foreground service type dataSync"). That is a normal state, not a bug, so
  // it must not be fatal. Catches Exception rather than the specific type because
  // that class only exists on API 31+ and minSdk here is 24.
  private fun tryStartForeground(): Boolean = try {
    startForeground(NOTIF_ID, buildNotification())
    true
  } catch (e: Exception) {
    Log.w(TAG, "startForeground refused; background sync paused until next foreground: ${e.message}")
    false
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // Swiping the app from recents kills the process on many OEMs; reschedule a
  // near-future restart so background sync resumes. A true force-stop / reinstall
  // cannot be revived until the user reopens the app.
  override fun onTaskRemoved(rootIntent: Intent?) {
    // If we never made it to foreground the budget is spent, so a restart would
    // only reproduce the failure. Leave it to the next app foreground to re-arm.
    if (!foregrounded) { super.onTaskRemoved(rootIntent); return }
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
