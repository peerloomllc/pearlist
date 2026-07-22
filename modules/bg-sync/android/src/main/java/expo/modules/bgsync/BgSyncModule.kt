package expo.modules.bgsync

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS bridge: start()/stop() the foreground service and persist the opt-in flag
// (read by BgSyncBootReceiver after a reboot). Called from the RN shell when the
// "Keep syncing in background" setting changes and at boot when it is on.
class BgSyncModule : Module() {
  private val prefsName = "pearlist_bgsync"

  override fun definition() = ModuleDefinition {
    Name("BgSync")

    Function("start") {
      val ctx: Context = appContext.reactContext ?: return@Function null
      ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        .edit().putBoolean("enabled", true).apply()
      // startForegroundService itself throws when the app is not allowed to start
      // one right now (background-start restrictions, or the Android 15+ dataSync
      // budget already spent). The opt-in is still recorded above, so the next
      // foreground re-arm picks it up; failing here must not take the app down.
      try {
        ContextCompat.startForegroundService(ctx, Intent(ctx, BgSyncService::class.java))
      } catch (e: Exception) {
        android.util.Log.w("BgSyncModule", "could not start sync service: ${e.message}")
      }
      null
    }

    Function("stop") {
      val ctx: Context = appContext.reactContext ?: return@Function null
      ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        .edit().putBoolean("enabled", false).apply()
      ctx.stopService(Intent(ctx, BgSyncService::class.java))
      null
    }
  }
}
