// Expo config plugin: strip the `aps-environment` entitlement (and any Push
// Notifications capability) that expo-notifications' own config plugin adds
// during prebuild. PearList uses LOCAL notifications only (no APNs / remote
// push), and signs with Xcode's wildcard team provisioning profile with EMPTY
// entitlements (see the 2026-07-01 iOS bring-up decision) so there is no
// Apple-portal trip. The aps-environment entitlement makes that wildcard profile
// reject the build ("doesn't include the Push Notifications capability"), so we
// remove it. Listed last in app.json plugins so it runs after expo-notifications.

const { withEntitlementsPlist } = require('expo/config-plugins')

module.exports = function withStripAps (config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment']
    return cfg
  })
}
