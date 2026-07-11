# QVAC on-device AI - integration notes (research, not a proposal)

Companion to the aisle-categorization scaffold (DECISIONS.md 2026-07-11, PR #49).
These are verified facts gathered from the published npm packages + the bare-kit
we already ship, so the on-device spike starts from a map instead of cold. No
model or QVAC dep is installed yet.

## What QVAC actually is, at the package level

- `@qvac/bare-sdk` (v0.14.1) - the Bare-runtime SDK. Flat functional API, all
  requireable from the one package:
  `const { plugins, loadModel, completion, unloadModel, embed, classify, downloadAsset, modelRegistrySearch } = require('@qvac/bare-sdk')`
  Plugins are registered explicitly, then you load a model and run inference:
  ```js
  const { llamacppCompletion } = require('@qvac/bare-sdk/llamacpp-completion/plugin')
  plugins([llamacppCompletion])                       // register the addon
  const modelId = await loadModel({ modelType: 'llamacpp-completion', /* files/config */ })
  const run = completion({ modelId, history: [{ role: 'user', content: '...' }] })
  const { text } = await run.final                    // or: for await (ev of run.events)
  ```
- `@qvac/llm-llamacpp` (v0.36.3) - the native addon. `engines.bare >= 1.24.0`.
  Installed SEPARATELY from bare-sdk (bare-sdk does NOT depend on it - you add
  only the addons you want). This is the big binary.
- Companion capabilities we might want later, same install pattern:
  `@qvac/bare-sdk/llamacpp-embedding/plugin` (embeddings - the lighter aisle
  route), `whispercpp-transcription` (voice item entry), `nmtcpp-translation`.

## The native-linking question - largely SOLVED by bare-kit

This was the scary unknown. It mostly is not one.

- `@qvac/llm-llamacpp` ships PREBUILT `.bare` addons, no source build:
  `prebuilds/android-arm64/qvac__llm-llamacpp.bare`,
  `prebuilds/ios-arm64/qvac__llm-llamacpp.bare` (+ ios-arm64-simulator, darwin,
  linux). llama.cpp is already compiled for our exact targets.
- `react-native-bare-kit@0.12.3` (already installed) auto-links `.bare` addons:
  - Android: `android/build.gradle` runs `link.mjs` in a `preBuild` task, which
    calls `bare-link` over the whole app tree scanning hosts
    `[android-arm64, ...]` and writes matches into `src/main/addons` (on
    `jniLibs.srcDirs`). Any node_modules dep with a matching `.bare` prebuild is
    pulled into the APK automatically.
  - iOS: `BareKit.podspec` has `prepare_command = "node link.mjs"` and
    `vendored_frameworks = "addons/*.xcframework"` - same mechanism, produces
    xcframeworks.
  - So there is likely NO custom Expo config plugin needed for linking. It rides
    RN autolinking + bare-kit's own build hooks, which fire during
    `expo prebuild` / pod install / gradle build.

## The residual risks - what the spike must actually verify

1. **Bare version.** `llm-llamacpp` needs `bare >= 1.24.0`. bare-kit 0.12.3
   embeds a prebuilt Bare of unknown version. VERIFY: log `Bare.versions` at
   worklet boot on-device; if too old, bump react-native-bare-kit.
2. **ggml backend .so companions (Android).** The android addon dlopens compute
   backends from a sibling dir `prebuilds/android-arm64/qvac__llm-llamacpp/*.so`
   (per-CPU-microarch, ~1.6MB each; plus opencl 1.9MB and vulkan 108MB). VERIFY
   bare-link copies those companions next to the `.bare`, not just the `.bare`
   itself - otherwise the addon loads but has no compute backend. This is the
   single most likely failure mode.
3. **App size.** Do NOT ship the 108MB vulkan backend. Confirm we can restrict
   to a CPU backend (+ the ~12MB `.bare`), so the add is ~13-15MB, not ~130MB.
4. **iOS deployment target.** QVAC iOS is 17.0+. Set via expo-build-properties
   (already a dep): `ios.deploymentTarget "17.0"`. Android needs API 31+ (12+).
5. **Model delivery.** Two options, decide after size is known:
   - bundle a small GGUF as an asset (simple, +size), or
   - `downloadAsset` / `modelRegistrySearch` from QVAC's distributed registry
     (DEFAULT_REGISTRY_CORE_KEY is baked in) on first run (no app-size hit, needs
     network once). The registry is itself Holepunch P2P.
6. **Worklet dep alignment.** bare-sdk pulls corestore ^7.4.5 / hyperswarm
   ^4.14.0 / hyperdrive - PearList already has compatible majors (corestore
   7.8, hyperswarm 4.17), same ecosystem, so low risk, but `npm ls` after install
   to confirm no duplicate-instance split of corestore/hypercore.

## Step-1 results (local, done 2026-07-11)

Installed `@qvac/bare-sdk` + `@qvac/llm-llamacpp` and wired a guarded boot probe
(`src/qvacProbe.mjs`, called from `src/bare.js` behind `QVAC_PROBE`). Findings
from packing the worklet locally:

- **bare-sdk plugin subpaths are import-only.** `@qvac/bare-sdk/llamacpp-completion/plugin`
  declares only an `import` condition in `exports` (no `require`/`default`), so
  `require()` from our CommonJS worklet fails with `PACKAGE_PATH_NOT_EXPORTED`.
  The plain `.` export has both conditions and requires fine; only the plugin
  subpaths are ESM-only. FIX we adopted: keep the worklet CJS, put QVAC-touching
  code in an `.mjs`, load it via dynamic `import('./qvacProbe.mjs')`. bare-pack
  resolves and bundles that chain cleanly.
- **Worklet bundle grows ~1-2MB -> 11.4MB** (bare-sdk pulls hyperdrive/hyperswarm/
  corestore JS into the worklet). `npm run verify` stays green: 48 tests pass,
  both Bare presets + UI build.
- `@qvac/llm-llamacpp` install footprint is **579MB** (all-platform prebuilds).
  bare-sdk itself is 8.9MB.
- NOT yet proven: the native `.bare` dlopening its ggml backend on-device (needs
  a model). That is the device build below.

## Step-2 results (on-device, TCL, done 2026-07-11)

Built arm64 standalone release + debug APKs, installed on the TCL (T513Z,
Android 15, arm64-v8a), ran the boot probe. Debug build needed because bare-kit
forwards worklet console to logcat only in debug (release is silent + not
debuggable, so pair-trace.log is unreachable). Probe line captured:

```
[pair worklet+2155ms] qvac:probe {
  "bareVersions":{"bare":"1.27.0","uv":"1.51.0","v8":"14.4.258.16"},
  "sdkImported":false, "pluginRegistered":false, "llamacppImported":false,
  "error":"import bare-sdk/plugin: ADDON_NOT_FOUND: Cannot find addon '.'
    imported from '.../@qvac/llm-llamacpp/binding.js'
    Candidates: - linked:libqvac__llm-llamacpp.0.36.3.so"
}
```

What this settles:
- ✅ **Bare version gate PASSES.** bare-kit 0.12.3 embeds Bare **1.27.0** (>= 1.24.0).
- ✅ Install + bundle + native link + boot all work on real arm64 hardware. No
  crash, no dlopen failure at app load. `libqvac__llm-llamacpp.0.36.3.so` + the 7
  CPU backends are packaged in the APK (confirmed via `unzip -l`), and bare-kit's
  `link.mjs` placed them as proper `lib/arm64-v8a/*.so`.
- ❌ **BLOCKER: Bare cannot load the linked addon at runtime.** binding.js runs and
  calls `require-addon('.')`, which computes the right candidate name
  (`linked:libqvac__llm-llamacpp.0.36.3.so`) but reports ADDON_NOT_FOUND. The .so
  is in the APK but the Bare runtime does not resolve/load it as a linked addon.

Leading hypotheses for the blocker (next dig, in rough priority):
1. **Versioned soname + `extractNativeLibs`.** Android may not load a multi-dot
   soname (`...0.36.3.so`) when native libs are not extracted (modern default).
   Try `android.useLegacyPackaging=true` / an extract-native-libs manifest flag.
2. **bare-kit third-party linked-addon resolution.** bare-kit statically ships its
   own bare-* core addons; a third-party prebuilt `.bare` shipped as a separate
   .so may not be registered in the `linked:` registry. PearList uses no non-core
   native addon today, so QVAC is the first to exercise this path. May need a
   newer bare-kit or an explicit addon-registration step.
3. Probe uses dynamic `import()` of the addon; a static top-level import in the
   .mjs might change how bare-pack registers the linked addon (cheap to try).

This is now a Holepunch/bare-kit addon-loading investigation, not app wiring.
Consult the holepunch-p2p-architect skill / p2p-wiki before the next device cycle.

## Step-3: ROOT CAUSE FOUND (2026-07-11)

The blocker is not a bug - it is that the probe used the WRONG integration path.

Evidence ruled out: version gate (Bare 1.27.0 OK), APK compression (.so is
`Stored`), missing NEEDED deps (all resolve), name mismatch (bundle keys QVAC's
addon `"."` -> `"linked:libqvac__llm-llamacpp.0.36.3.so"` exactly like the working
sodium-native), and there is zero linker/dlopen error in the device log. The
addon resolves but the linked load returns not-found.

Reading tetherto/qvac source settles it. QVAC's supported mobile integration is
NOT "require @qvac/bare-sdk inside your own worklet + plain bare-pack." It is:
- `@qvac/sdk` (the full SDK) + its Expo config plugin `@qvac/sdk/expo-plugin`
  (`withMobileBundle`), which during `expo prebuild`:
  - runs QVAC's OWN bundler (`bundleSdk`) to emit `worker.mobile.bundle.js`,
  - runs `verifyBundle` (ABI check against the Bare runtime version),
  - PATCHES react-native-bare-kit's android/ios `link.mjs` to be
    addons-manifest-aware (`qvac/addons.manifest.json` allowlist).
- QVAC then runs as its OWN Bare worker (react-native-bare-kit Worklet, managed
  by the SDK's `expo-rpc-client` over `bare-rpc`); the app talks to it via RPC.
- Physical device only ("QVAC currently does not run on emulators").

My spike loaded @qvac/bare-sdk inside PearList's P2P worklet and packed it with
stock `bare-pack --linked` + stock bare-kit linker - skipping bundleSdk,
verifyBundle, and the linker patch. That is why the addon never loads.

### Corrected integration (the real plan)

Architecturally this is "QVAC on the RN side" (the Option B from the original
assessment), running as a SECOND worker alongside PearList's P2P worklet:
1. `npm i @qvac/sdk bare-rpc` (drop the direct `@qvac/bare-sdk` +
   `@qvac/llm-llamacpp` deps and the in-worklet probe).
2. `npx expo install expo-device` (expo-file-system/build-properties already in).
3. app.json plugins: add `"@qvac/sdk/expo-plugin"` (minSdkVersion 29 already set).
   Pass the Bare runtime version explicitly for ABI checks: **1.27.0** (bare-kit
   0.12.3 does not expose it; we measured it on-device).
4. `npx expo prebuild` -> QVAC bundles + verifies + patches the linkers.
5. From the RN shell (App.jsx), use the `@qvac/sdk` API (loadModel/completion or
   embed) to classify, then persist via the existing `ai:categorize`/`item:edit`
   worklet method so the category still syncs P2P. `classifyAisle` (aisles.js)
   stays as the offline fallback + today's shipping behavior.
6. Retest on the TCL (physical device required).

Revert from the branch before the corrected path: the `QVAC_PROBE` block in
bare.js, `src/qvacProbe.mjs`, and the direct @qvac/bare-sdk/@qvac/llm-llamacpp
deps. Keep aisles.js, the worklet ai:* methods, and the UI grouping.

## Step-4: corrected integration WORKS on-device (2026-07-11)

Adopted the supported path: dropped @qvac/bare-sdk, added `@qvac/sdk` + `bare-rpc`
+ `expo-device`, added `@qvac/sdk/expo-plugin` to app.json, and a `qvac.config.json`
(`plugins: ["@qvac/sdk/llamacpp-completion/plugin"]`, `bareRuntimeVersion: "1.27.0"`).
`expo prebuild` then bundled QVAC's own worker, ABI-verified it against Bare
1.27.0, and patched bare-kit's linker (addons manifest scoped to llm-llamacpp +
core/P2P addons only - no whisper/ocr/diffusion). A smoke test in the RN shell
(app/qvacSmoke.ts) downloaded + loaded LLAMA_3_2_1B_INST_Q4_0 (cpu) and classified
5 items. Full run on the TCL (arm64, Android 15): download 100% -> model loaded ->
5 classifications -> DONE OK. **No ADDON_NOT_FOUND. The blocker is resolved.**

But the practical result is mixed:
- Classification QUALITY (zero-shot, 1B, naive prompt) was 2/5 correct:
  cilantro->Pantry (want Produce), whole milk->Meat&Seafood (want Dairy),
  chicken->Meat&Seafood (ok), toilet paper->Pantry (want Household),
  ice cream->Frozen (ok). The offline keyword classifier gets all 5 right.
- MEMORY: loading the 1B model caused severe low-memory-killer thrash on the TCL
  (it culled ~everything; our foreground app survived). Low-end devices are at
  their limit with a 1B model.
- LATENCY: ~1.7-3.4s per item on CPU. Fine for background, not instant.
- COST: ~0.8GB model download on first run, +~13-15MB app native size.

Conclusion: QVAC is technically viable and correctly integrated, but a 1B LLM
with a zero-shot prompt is WORSE than the free deterministic classifier for fixed
aisle labels. To make the LLM worth it: few-shot / grammar-constrained decoding to
the aisle set, or the smaller embeddings model (nearest-label), or a better model
on capable devices only. Recommendation: keep aisles.js as the shipping path; treat
QVAC as opt-in / capable-device-only, and only if constrained decoding beats the
keyword classifier in an A/B. QVAC_SMOKE left OFF in the code.

## First spike steps (in order)

1. `npm i @qvac/bare-sdk @qvac/llm-llamacpp` in pearlist.
2. In `src/bare.js`, at boot, log `Bare.versions` and try
   `plugins([llamacppCompletion])` behind a try/catch - just prove the addon
   loads. Do NOT load a model yet.
3. `expo prebuild --clean`, build debug to the Pixel, watch the bare-link output
   and confirm the `.bare` + a CPU `.so` landed in the APK; check the boot log.
4. Only then wire `classifyItem` in `src/listMethods.js` (the existing seam) to
   `loadModel` + `completion` with a tiny GGUF, keeping `classifyAisle` as the
   offline fallback.

## Alternative worth a look: embeddings, not an LLM

Aisle assignment is a fixed-label classification. `@qvac/bare-sdk/llamacpp-embedding`
+ nearest-label cosine is a smaller model and faster than a generative LLM, and
maps cleanly onto the same `classifyItem` seam. If step 3 shows the LLM is too
heavy on our low-end targets, pivot the spike to embeddings before abandoning it.
