import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// Android-only recovery for the GrapheneOS/Vanadium WebView resume-freeze (see
// android/ and /home/tim/peerloomllc/WEBVIEW_FREEZE_FIX_PORT.md). iOS is
// unaffected: WKWebView has no equivalent cached-app renderer freezer, so on iOS
// the native module is simply absent and every call here is a no-op.
const WebViewRecovery = requireOptionalNativeModule<{
  terminateRenderer(): Promise<number>
}>('WebViewRecovery')

export const webViewRecoverySupported = Platform.OS === 'android' && !!WebViewRecovery

// Kill the render process behind the app's WebView so the next paint comes from
// a FRESH one bound to the current window surface. Resolves with the number of
// renderers terminated; 0 just means there was nothing to do.
//
// This is deliberately destructive - it is the whole mechanism, not a side
// effect. The WebView's onRenderProcessGone handler is what reloads afterwards,
// so the two halves have to stay wired together.
//
// Never throws: recovery must not be able to make a working app worse.
export async function terminateWebViewRenderer (): Promise<number> {
  if (!webViewRecoverySupported) return 0
  try {
    return await WebViewRecovery!.terminateRenderer()
  } catch {
    return 0
  }
}
