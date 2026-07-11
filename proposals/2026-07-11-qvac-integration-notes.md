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
