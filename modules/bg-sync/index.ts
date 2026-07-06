import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// Android-only foreground-service module (see android/). On iOS/web the native
// module is absent, so bgSyncSupported is false and the calls are no-ops - iOS
// cannot keep a P2P app alive in the background (App Store restrictions).
const BgSync = requireOptionalNativeModule<{ start(): void; stop(): void }>('BgSync')

export const bgSyncSupported = Platform.OS === 'android' && !!BgSync

// Start/stop the persistent foreground service that keeps the app process (and
// thus the Bare worklet + Hyperswarm connections) alive while backgrounded, so
// this device stays a reliable P2P sync/relay point. start() also persists the
// opt-in so the boot receiver can resume it after a reboot. Never throws.
export function startBackgroundSync () {
  if (bgSyncSupported) { try { BgSync!.start() } catch {} }
}
export function stopBackgroundSync () {
  if (bgSyncSupported) { try { BgSync!.stop() } catch {} }
}
