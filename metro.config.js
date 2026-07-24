const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
config.resolver.assetExts.push('bundle')

// Drop @qvac/langdetect-text (and its 2 MB tinyld/heavy table) from the RN bundle.
// It arrives only through the QVAC SDK's translate API, which PearList never calls,
// and Metro does not tree-shake, so an unreachable import still costs full size.
// See shims/qvac-langdetect-stub.js for what the stub does and how to undo this.
const LANGDETECT_STUB = path.resolve(__dirname, 'shims/qvac-langdetect-stub.js')
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@qvac/langdetect-text') {
    return { type: 'sourceFile', filePath: LANGDETECT_STUB }
  }
  return (defaultResolveRequest || context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
