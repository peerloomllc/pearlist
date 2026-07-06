// Expo config plugin: wire a real release signingConfig into the generated
// android/app/build.gradle. PearList regenerates android/ from app.json + config
// plugins on every `expo prebuild` (android/ is gitignored, no custom native
// code), so a hand-edit to build.gradle would be wiped on the next prebuild.
// This plugin is the durable source of truth for release signing.
//
// The injected `release` signingConfig reads its credentials from the
// environment first, then from Gradle properties (~/.gradle/gradle.properties or
// -P flags), so the keystore and passwords never live in the repo. If none are
// configured the release build falls back to the debug keystore (unchanged
// behavior), which keeps local `assembleRelease` working before the upload
// keystore exists.
//
// Credentials (env var or Gradle property, same names release.sh exports):
//   KEYSTORE_FILE      absolute path to the .jks upload keystore
//   KEYSTORE_PASSWORD  keystore (store) password
//   KEY_ALIAS          key alias inside the keystore
//   KEY_PASSWORD       key password
//
// Mirrors the committed pattern in pearguard/android/app/build.gradle.

const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE_SIGNING_CONFIG = `        release {
            def ksFile = System.getenv("KEYSTORE_FILE") ?: findProperty("KEYSTORE_FILE")
            def ksPassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD")
            def kAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS")
            def kPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD")
            if (ksFile && ksPassword && kAlias && kPassword) {
                storeFile file(ksFile)
                storePassword ksPassword
                keyAlias kAlias
                keyPassword kPassword
            }
        }
`

module.exports = function withAndroidReleaseSigning (config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents

    // 1. Add a `release` signingConfig next to the template's `debug` one.
    //    Anchor on the end of the debug block + close of signingConfigs.
    const signingAnchor = /(keyPassword 'android'\n {8}}\n)( {4}}\n)/
    if (signingAnchor.test(contents) && !contents.includes('def ksFile = System.getenv')) {
      contents = contents.replace(
        signingAnchor,
        `$1${RELEASE_SIGNING_CONFIG}$2`
      )
    }

    // 2. Point the release buildType at the release signingConfig when a real
    //    keystore is configured, else keep the debug fallback. The "Caution!"
    //    comment uniquely identifies the release buildType (not the debug one).
    contents = contents.replace(
      /(\/\/ see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\n {12}signingConfig )signingConfigs\.debug/,
      '$1signingConfigs.release.storeFile ? signingConfigs.release : signingConfigs.debug'
    )

    cfg.modResults.contents = contents
    return cfg
  })
}
