// Expo config plugin: PearList's iOS Share Extension (proposals/2026-10-29-keep-style-notes.md,
// part 6). Android receives shares in the app itself (modules/share-intent); iOS will only
// put an app in the share menu through an extension, a second, separate program shipped
// inside the app.
//
// What changes in the generated ios/:
// - ios/PearListShare/ gets ShareViewController.swift and Info.plist from
//   plugins/ios-share-extension/, plus an entitlements file naming the App Group.
// - The Xcode project gets a PearListShare app-extension target (bundle id
//   <app id>.share), embedded in the app and built with it.
// - The app's own entitlements gain the same App Group, the folder both sides use
//   to hand a share over.
//
// SIGNING: the extension is its own app ID, so a device or App Store build needs
// <app id>.share registered with the App Group capability, and a provisioning
// profile for it (scripts/ios-appstore.sh reads IOS_SHARE_PROVISIONING_PROFILE). The
// Simulator needs neither.
//
// Running it again on an ios/ that already has the target changes nothing.

const fs = require('fs')
const path = require('path')
const { withEntitlementsPlist, withXcodeProject, withDangerousMod } = require('expo/config-plugins')

const NAME = 'PearListShare'
const SRC = path.join(__dirname, 'ios-share-extension')
const FILES = ['ShareViewController.swift', 'Info.plist', `${NAME}.entitlements`]
const DEPLOYMENT_TARGET = '15.1'

const groupOf = (config) => `group.${config.ios.bundleIdentifier}`

function entitlements (group) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${group}</string>
  </array>
</dict>
</plist>
`
}

const withAppGroup = (config) => withEntitlementsPlist(config, (c) => {
  const key = 'com.apple.security.application-groups'
  const groups = new Set(c.modResults[key] || [])
  groups.add(groupOf(c))
  c.modResults[key] = [...groups]
  return c
})

const withFiles = (config) => withDangerousMod(config, ['ios', (c) => {
  const dir = path.join(c.modRequest.platformProjectRoot, NAME)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['ShareViewController.swift', 'Info.plist']) fs.copyFileSync(path.join(SRC, f), path.join(dir, f))
  fs.writeFileSync(path.join(dir, `${NAME}.entitlements`), entitlements(groupOf(c)))
  return c
}])

const withTarget = (config) => withXcodeProject(config, (c) => {
  const proj = c.modResults
  // Names are stored quoted ("PearListShare"), which pbxTargetByName does not allow for.
  const targets = proj.pbxNativeTargetSection()
  if (Object.values(targets).some((t) => t && (t.name === NAME || t.name === `"${NAME}"`))) return c
  const bundleId = `${c.ios.bundleIdentifier}.share`

  const group = proj.addPbxGroup(FILES, NAME, NAME)
  proj.addToPbxGroup(group.uuid, proj.getFirstProject().firstProject.mainGroup)

  const target = proj.addTarget(NAME, 'app_extension', NAME, bundleId)
  proj.addBuildPhase(['ShareViewController.swift'], 'PBXSourcesBuildPhase', 'Sources', target.uuid)
  proj.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
  proj.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)

  const configs = proj.pbxXCBuildConfigurationSection()
  for (const key of Object.keys(configs)) {
    const bs = configs[key].buildSettings
    if (!bs || bs.PRODUCT_NAME !== `"${NAME}"`) continue
    Object.assign(bs, {
      INFOPLIST_FILE: `${NAME}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${NAME}/${NAME}.entitlements`,
      CODE_SIGN_STYLE: 'Automatic',
      PRODUCT_BUNDLE_IDENTIFIER: bundleId,
      IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: '5.0',
      MARKETING_VERSION: c.version,
      CURRENT_PROJECT_VERSION: c.ios.buildNumber || '1',
      GENERATE_INFOPLIST_FILE: 'NO',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      SKIP_INSTALL: 'YES',
    })
  }
  return c
})

module.exports = (config) => withTarget(withFiles(withAppGroup(config)))
