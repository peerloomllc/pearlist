package expo.modules.savefile

import android.app.Activity
import android.content.Intent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// "Save as" for Android: ACTION_CREATE_DOCUMENT.
//
// WHY NOT THE OBVIOUS ROUTES, both of which we tried and measured on 2026-07-28:
//
//   Share sheet (expo-sharing). It only offers APPS, and which apps can put a file
//   into storage varies by device. On GrapheneOS there is no "save to Downloads"
//   target at all, so the backup had nowhere to go - the report that started this.
//
//   SAF directory permissions (FileSystem.StorageAccessFramework). Android REFUSES
//   to grant a persistent directory permission on Downloads or on the storage root:
//   the picker shows "Can't use this folder - To protect your privacy, choose
//   another folder" with the confirm button disabled. That is an OS rule since
//   Android 11, not a GrapheneOS one; the TCL (stock Android 13) does the same.
//
// ACTION_CREATE_DOCUMENT is what every Android app actually uses for "save a file
// somewhere": the system Save-as dialog, which CAN write to Downloads, opens where
// the user last saved, pre-fills the name, and lets them go anywhere including a
// cloud provider. It grants access to exactly the one file it returns, so there is
// no directory permission to hold and nothing extra to justify.
//
// iOS is unaffected: WKWebView aside, the iOS share sheet's "Save to Files" IS the
// same choose-a-folder flow, so the shell keeps using it there and this module is
// simply absent (requireOptionalNativeModule -> the JS side reports unsupported).
private const val CREATE_DOCUMENT_REQUEST = 0xF11E

class SaveFileModule : Module() {
  // The save in flight. Only one can exist: the dialog is modal, so a second call
  // before the first returns is a bug in the caller, not a case to queue for.
  private var pendingPromise: Promise? = null
  private var pendingContent: String? = null

  override fun definition() = ModuleDefinition {
    Name("SaveFile")

    // Resolves { canceled: true } if the user backs out, or
    // { canceled: false, uri, name } once the bytes are written. NEVER rejects for
    // a cancel: backing out of a save dialog is a decision, not a failure.
    AsyncFunction("saveText") { filename: String, content: String, mimeType: String?, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_NO_ACTIVITY", "no current activity to present the save dialog", null)
        return@AsyncFunction
      }
      if (pendingPromise != null) {
        promise.reject("ERR_SAVE_IN_PROGRESS", "a save dialog is already open", null)
        return@AsyncFunction
      }
      pendingPromise = promise
      pendingContent = content
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mimeType ?: "application/json"
        putExtra(Intent.EXTRA_TITLE, filename)
      }
      try {
        activity.startActivityForResult(intent, CREATE_DOCUMENT_REQUEST)
      } catch (e: Exception) {
        clearPending()
        promise.reject("ERR_NO_PICKER", "this device has no file picker: " + (e.message ?: ""), e)
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CREATE_DOCUMENT_REQUEST) return@OnActivityResult
      val promise = pendingPromise ?: return@OnActivityResult
      val content = pendingContent ?: ""
      clearPending()

      val uri = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) {
        promise.resolve(mapOf("canceled" to true))
        return@OnActivityResult
      }
      try {
        // "wt" truncates. Plain "w" leaves the tail of a longer previous file in
        // place when the user overwrites one, which would corrupt a backup into
        // something that still parses as far as the old content went.
        val resolver = appContext.reactContext?.contentResolver
          ?: throw IllegalStateException("no content resolver")
        resolver.openOutputStream(uri, "wt").use { out ->
          if (out == null) throw IllegalStateException("could not open the chosen file for writing")
          out.write(content.toByteArray(Charsets.UTF_8))
          out.flush()
        }
        promise.resolve(mapOf("canceled" to false, "uri" to uri.toString(), "name" to displayName(uri.toString())))
      } catch (e: Exception) {
        promise.reject("ERR_WRITE_FAILED", "could not write the file: " + (e.message ?: ""), e)
      }
    }
  }

  private fun clearPending() {
    pendingPromise = null
    pendingContent = null
  }

  // Best-effort human label from the returned document URI, for telling the user
  // where their backup went. Querying the provider for DISPLAY_NAME would be more
  // correct, but this is a hint in a confirmation message, not a filename we act on.
  private fun displayName(uri: String): String {
    val decoded = try { java.net.URLDecoder.decode(uri, "UTF-8") } catch (e: Exception) { uri }
    return decoded.substringAfterLast('/').substringAfterLast(':')
  }
}
