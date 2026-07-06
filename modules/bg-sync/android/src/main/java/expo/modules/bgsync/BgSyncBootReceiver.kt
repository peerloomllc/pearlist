package expo.modules.bgsync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

// Resumes the sync foreground service after a device reboot, but only if the
// user left "Keep syncing in background" on (the module persists that flag to
// SharedPreferences). Passes wakeHost so the service brings the app up to start
// the Bare worklet, since nothing else is running yet after boot.
class BgSyncBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val prefs = context.getSharedPreferences("pearlist_bgsync", Context.MODE_PRIVATE)
    if (!prefs.getBoolean("enabled", false)) return
    val svc = Intent(context, BgSyncService::class.java)
      .putExtra(BgSyncService.EXTRA_WAKE_HOST, true)
    ContextCompat.startForegroundService(context, svc)
  }
}
