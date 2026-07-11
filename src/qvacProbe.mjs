// QVAC "does it even load" probe (on-device spike, 2026-07-11). ESM by
// necessity: @qvac/bare-sdk's plugin subpaths are import-only (their `exports`
// declare an `import` condition with no `require`/`default`), so bare-pack
// cannot resolve them from CommonJS. The CJS worklet (bare.js) loads this via a
// guarded dynamic import().
//
// This proves the FIRST gate only: that bare-sdk + the llamacpp plugin import,
// that the plugin registers, and what Bare version bare-kit embeds (llm-llamacpp
// needs bare >= 1.24.0). It does NOT yet load a model, so it does not prove the
// native .bare addon dlopens its ggml backend .so files - that needs a real
// GGUF and is spike step 2. See proposals/2026-07-11-qvac-integration-notes.md.

// Deferred so a resolve/import failure is reported, never thrown into boot.
export async function probeQvac () {
  const out = { bareVersions: null, sdkImported: false, pluginRegistered: false, llamacppImported: false, error: null }

  // 1. Bare version gate (definitive, cheap).
  try { out.bareVersions = (typeof Bare !== 'undefined' && Bare.versions) ? Bare.versions : 'no-Bare-global' } catch (e) { out.bareVersions = 'err:' + (e && e.message) }

  // 2. Import the SDK + the llamacpp plugin + the native addon package.
  let plugins, llamacppCompletion
  try {
    ({ plugins } = await import('@qvac/bare-sdk'))
    ;({ llamacppCompletion } = await import('@qvac/bare-sdk/llamacpp-completion/plugin'))
    out.sdkImported = true
  } catch (e) { out.error = 'import bare-sdk/plugin: ' + (e && e.message); return out }

  try { await import('@qvac/llm-llamacpp'); out.llamacppImported = true } catch (e) { out.error = 'import llm-llamacpp: ' + (e && e.message) }

  // 3. Register the plugin (catches native-binding wiring errors early).
  try {
    if (typeof plugins === 'function' && llamacppCompletion) { plugins([llamacppCompletion]); out.pluginRegistered = true }
  } catch (e) { out.error = 'plugins([llamacpp]): ' + (e && e.message) }

  return out
}
