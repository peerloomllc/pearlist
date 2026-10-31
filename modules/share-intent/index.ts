import { Platform, AppState, Linking } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// Things shared INTO PearList from another app's share sheet.
//
// Android: the app receives the share itself (android/.../ShareIntentModule.kt).
// iOS: the Share Extension (plugins/ios-share-extension) saves it to the App Group
// folder and opens pearlist://share (its own scheme: Keet also answers pear://); ios/ShareIntentModule.swift reads it.
export type Shared = { text: string | null, subject: string | null, images: string[] }

const ShareIntent = requireOptionalNativeModule<{
  take(): Shared | null
  addListener(event: 'onShare', cb: () => void): { remove(): void }
}>('ShareIntent')

export const shareIntentSupported = (Platform.OS === 'android' || Platform.OS === 'ios') && !!ShareIntent

// The share waiting to be handled, once: a second call returns null.
export function takeShared (): Shared | null {
  if (!shareIntentSupported) return null
  try { return ShareIntent!.take() } catch { return null }
}

// Called when a share may have arrived while the app is already running. On iOS
// that is the extension's link, or the app coming to the front (in case iOS would
// not let the extension open it); take() returns null when there is nothing.
export function onShared (cb: () => void): () => void {
  if (!shareIntentSupported) return () => {}
  if (Platform.OS === 'ios') {
    const a = AppState.addEventListener('change', (s) => { if (s === 'active') cb() })
    const l = Linking.addEventListener('url', ({ url }) => { if (/^pearlist:\/\/share/.test(url)) cb() })
    return () => { a.remove(); l.remove() }
  }
  const sub = ShareIntent!.addListener('onShare', cb)
  return () => sub.remove()
}
