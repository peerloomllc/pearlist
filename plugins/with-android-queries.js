// Expo config plugin: declare an Android <queries> block so the app can probe
// for and open external handlers under Android 11+ package visibility. Without
// this, Linking.canOpenURL()/openURL() return false for custom schemes even
// when a matching app is installed. We declare:
//   - lightning:  detect an installed Lightning wallet (BTC donation flow)
//   - bitcoin:    on-chain fallback
//   - https:      open donation / info links in a browser
//   - mailto:     contact / support email
//   - IMAGE_CAPTURE: the camera app, for "Take photo" on an item. The WebView
//     file chooser (react-native-webview) calls resolveActivity on this intent
//     and silently does nothing when the camera is not visible to us - measured
//     on the emulator 2026-09-23: "there is no Activity to handle this Intent".
// Kept intentionally narrow (only what the app actually queries).

const { withAndroidManifest } = require('expo/config-plugins')

const SCHEMES = ['lightning', 'bitcoin', 'https']

module.exports = function withAndroidQueries (config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest
    manifest.queries = manifest.queries || []

    const intents = SCHEMES.map((scheme) => ({
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': scheme } }],
    }))
    // Email uses ACTION_SENDTO with a mailto: data scheme.
    intents.push({
      action: [{ $: { 'android:name': 'android.intent.action.SENDTO' } }],
      data: [{ $: { 'android:scheme': 'mailto' } }],
    })

    intents.push({
      action: [{ $: { 'android:name': 'android.media.action.IMAGE_CAPTURE' } }],
    })

    manifest.queries.push({ intent: intents })
    return cfg
  })
}
