const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// The worklet and UI bundles ride along as assets (assets/bare-*.bundle,
// assets/app-ui.bundle), so Metro has to treat .bundle as an asset rather than
// try to parse it as JavaScript.
config.resolver.assetExts.push('bundle')

// This file used to carry a resolver that swapped @qvac/langdetect-text for a
// stub, keeping 2 MB of language-detection tables out of the RN bundle (PR #82).
// It went with the on-device AI on 2026-07-26: no QVAC dependency, nothing to
// trim, and shims/qvac-langdetect-stub.js went with it.

module.exports = config
