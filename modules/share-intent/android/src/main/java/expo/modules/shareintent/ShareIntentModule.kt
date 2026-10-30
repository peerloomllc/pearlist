package expo.modules.shareintent

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream

// Receives ACTION_SEND / ACTION_SEND_MULTIPLE from another app's share sheet
// (proposals/2026-10-29-keep-style-notes.md, part 6). A cold start carries the share
// on the launch intent; a warm one arrives through onNewIntent (the activity is
// singleTask). Either way the payload waits here until the shell takes it, since
// the WebView may not be ready yet.
//
// Pictures are decoded here and sent on as JPEG data URLs no longer than
// MAX_EDGE on a side. A 12 MP original is several MB, and the whole payload
// crosses the bridge and then the WebView as a string. The UI makes the stored
// photo and thumbnail from this copy, the same way it does for a picked file.
private const val MAX_EDGE = 2048
private const val MAX_IMAGES = 10

class ShareIntentModule : Module() {
  private var pending: Map<String, Any?>? = null

  override fun definition() = ModuleDefinition {
    Name("ShareIntent")
    Events("onShare")

    OnNewIntent { intent ->
      if (capture(intent)) sendEvent("onShare", mapOf<String, Any?>())
    }

    Function("take") {
      if (pending == null) appContext.currentActivity?.intent?.let { capture(it) }
      val p = pending
      pending = null
      p
    }
  }

  private fun capture (intent: Intent): Boolean {
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
    // Mark it handled, so a later take() on the same launch intent finds nothing.
    intent.action = Intent.ACTION_MAIN
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) streamOf(intent)?.let { uris.add(it) }
    else uris.addAll(streamsOf(intent))
    val images = uris.take(MAX_IMAGES).mapNotNull { uri ->
      runCatching { jpegDataUrl(uri) }.onFailure { Log.w("PearListShare", "could not read a shared picture: $it") }.getOrNull()
    }
    if (text.isNullOrBlank() && images.isEmpty()) return false
    pending = mapOf("text" to text, "subject" to subject, "images" to images)
    return true
  }

  @Suppress("DEPRECATION")
  private fun streamOf (intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamsOf (intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

  private fun jpegDataUrl (uri: Uri): String? {
    val resolver = appContext.reactContext?.contentResolver ?: return null
    val type = resolver.getType(uri)
    if (type != null && !type.startsWith("image/")) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2
    var bmp = resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: return null
    val edge = maxOf(bmp.width, bmp.height)
    if (edge > MAX_EDGE) {
      val s = MAX_EDGE.toFloat() / edge
      bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * s).toInt().coerceAtLeast(1), (bmp.height * s).toInt().coerceAtLeast(1), true)
    }
    // BitmapFactory ignores EXIF orientation, so a phone photo would come out on
    // its side. Re-encoding below also drops the EXIF, GPS included.
    val degrees = resolver.openInputStream(uri)?.use {
      when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
      }
    } ?: 0f
    if (degrees != 0f) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(degrees) }, true)
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }
}
