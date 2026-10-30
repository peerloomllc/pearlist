import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// Things shared INTO PearList from another app's share sheet (Android only). See
// android/.../ShareIntentModule.kt. iOS needs a Share Extension and is not done.
export type Shared = { text: string | null, subject: string | null, images: string[] }

const ShareIntent = requireOptionalNativeModule<{
  take(): Shared | null
  addListener(event: 'onShare', cb: () => void): { remove(): void }
}>('ShareIntent')

export const shareIntentSupported = Platform.OS === 'android' && !!ShareIntent

// The share waiting to be handled, once: a second call returns null.
export function takeShared (): Shared | null {
  if (!shareIntentSupported) return null
  try { return ShareIntent!.take() } catch { return null }
}

// Called when a share arrives while the app is already running.
export function onShared (cb: () => void): () => void {
  if (!shareIntentSupported) return () => {}
  const sub = ShareIntent!.addListener('onShare', cb)
  return () => sub.remove()
}
