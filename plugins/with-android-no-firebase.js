// Expo config plugin: leave Firebase out of the Android app.
//
// expo-notifications depends on firebase-messaging for remote push. PearList
// uses LOCAL notifications only (no FCM, no google-services.json, no push token),
// so Firebase never starts, but its classes and manifest entries (Firebase
// Installations, Cloud Messaging, datatransport) still ship and tracker scanners
// such as Exodus and App Manager list them. Raised on Nostr 2026-10-30.
//
// The app's runtime classpaths exclude the Firebase and datatransport groups
// (expo-notifications still compiles against them), and the manifest drops
// expo-notifications' FCM service and FCM icon entries. The Firebase classes
// it still names are only reached for a remote message, which never arrives.

const { withAppBuildGradle, withAndroidManifest } = require('expo/config-plugins')

const MARK = '// with-android-no-firebase'
const GRADLE = `
${MARK}
configurations.matching { it.name.toLowerCase().endsWith('runtimeclasspath') }.all {
    exclude group: 'com.google.firebase'
    exclude group: 'com.google.android.datatransport'
}
`
const FCM_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'

module.exports = function withAndroidNoFirebase (config) {
  config = withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARK)) cfg.modResults.contents += GRADLE
    return cfg
  })
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools'
    const app = manifest.application[0]
    app.service = (app.service || []).filter((s) => s.$['android:name'] !== FCM_SERVICE)
    app.service.push({ $: { 'android:name': FCM_SERVICE, 'tools:node': 'remove' } })
    // expo-notifications' own plugin writes the icon and colour under FCM's
    // names too; local notifications read its expo.modules.* copies.
    app['meta-data'] = (app['meta-data'] || []).filter((m) => !String(m.$['android:name']).startsWith('com.google.firebase.'))
    return cfg
  })
}
