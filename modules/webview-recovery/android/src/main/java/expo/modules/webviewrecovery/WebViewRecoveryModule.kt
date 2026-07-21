package expo.modules.webviewrecovery

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// GrapheneOS/Vanadium WebView resume-freeze recovery.
// See /home/tim/peerloomllc/WEBVIEW_FREEZE_FIX_PORT.md; reference implementation
// PearCircle PR #165.
//
// Android's cached-app freezer cgroup-freezes the WebView's out-of-process
// Vanadium renderer while the app is backgrounded. Since the 2026-07-19 Vanadium
// 151.0.7922 update, on resume the app gets a NEW window surface but the thawed
// renderer's compositor never re-attaches to it: zero new buffers, so the screen
// is frozen. JS, input and haptics keep working, because those live in a
// separate, healthy process - which is exactly why it reads as a UI hang rather
// than a crash.
//
// Only a FRESH render process recovers it. That is why a view-remount does NOT
// work and was reverted upstream: rebinding the WebView reuses the same pooled,
// stale renderer. WebViewRenderProcess.terminate() (API 29+, and this app's
// minSdk is 29) kills just this app's renderer; the JS onRenderProcessGone
// handler then reloads, binding a fresh renderer to the current surface.
class WebViewRecoveryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WebViewRecovery")

    // Terminates the renderer behind every WebView in the current activity and
    // resolves with how many were actually terminated (0 is a normal answer: no
    // activity, no WebView attached yet, or a WebView with no live renderer).
    // Never rejects for the ordinary cases, so the caller does not have to treat
    // "nothing to do" as an error.
    AsyncFunction("terminateRenderer") { promise: Promise ->
      val activity = appContext.activityProvider?.currentActivity
      if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve(0)
        return@AsyncFunction
      }
      // WebView APIs are UI-thread only; terminate() from any other thread throws.
      activity.runOnUiThread {
        try {
          var terminated = 0
          for (webView in findWebViews(activity.window?.decorView)) {
            if (webView.webViewRenderProcess?.terminate() == true) terminated++
          }
          promise.resolve(terminated)
        } catch (e: Throwable) {
          promise.reject("terminate_failed", e.message ?: "renderer terminate failed", e)
        }
      }
    }
  }

  // Walk the view tree rather than holding a WebView reference: the shell owns
  // the WebView and this module has no handle on it, and the tree is tiny.
  private fun findWebViews(root: View?): List<WebView> {
    if (root == null) return emptyList()
    val found = ArrayList<WebView>()
    val stack = ArrayDeque<View>()
    stack.addLast(root)
    while (stack.isNotEmpty()) {
      val view = stack.removeLast()
      if (view is WebView) found.add(view)
      if (view is ViewGroup) for (i in 0 until view.childCount) stack.addLast(view.getChildAt(i))
    }
    return found
  }
}
