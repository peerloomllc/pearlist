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
    // A throw inside a BroadcastReceiver crashes the app just as loudly as one in
    // the service, and BOOT_COMPLETED is exactly when we cannot afford that.
    try {
      ContextCompat.startForegroundService(context, svc)
    } catch (e: Exception) {
      android.util.Log.w("BgSyncBoot", "could not start sync service at boot: ${e.message}")
    }
  }
}
