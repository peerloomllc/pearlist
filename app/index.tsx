// PearList shell: hosts the Bare worklet (P2P backend) and the WebView UI, and
// bridges IPC between them. No custom native code - the worklet and WebView are
// pure RN libraries. Mirrors PearCircle's shell minus the location stack; adds
// WebView camera permission for the in-WebView QR scanner.

import { useEffect, useRef, useState } from 'react'
import { View, Platform, Share, StatusBar, BackHandler } from 'react-native'
import { WebView } from 'react-native-webview'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import * as Linking from 'expo-linking'
import * as Haptics from 'expo-haptics'
import AsyncStorage from '@react-native-async-storage/async-storage'

// --- worklet + IPC (module-scoped so it survives remounts) -----------------
let _worklet: any = null
let _workletStarted = false
let _webViewRef: { current: any } | null = null
const _pending = new Map<number, (msg: any) => void>()
let _nextId = 1

function sendToWorklet (msg: object) {
  _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}
function callRaw (method: string, args: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = _nextId++
    _pending.set(id, (msg) => resolve(msg))
    sendToWorklet({ id, method, args })
  })
}
function emitEvent (event: string, data?: any) {
  _webViewRef?.current?.injectJavaScript(`window.__pearEvent(${JSON.stringify(event)}, ${JSON.stringify(data ?? null)}); true;`)
}

async function startWorklet () {
  if (_workletStarted) return
  _workletStarted = true
  const asset = Asset.fromModule(
    Platform.OS === 'ios' ? require('../assets/bare-ios.bundle') : require('../assets/bare-universal.bundle')
  )
  await asset.downloadAsync()
  const bundle = await FileSystem.readAsStringAsync(asset.localUri!, { encoding: FileSystem.EncodingType.Base64 })

  _worklet = new Worklet()
  await _worklet.start('/app.bundle', b4a.from(bundle, 'base64'))

  let buffer = ''
  _worklet.IPC.on('data', (chunk: any) => {
    buffer += b4a.toString(chunk)
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && _pending.has(msg.id)) { _pending.get(msg.id)!(msg); _pending.delete(msg.id) }
        else if (msg.event) emitEvent(msg.event, msg.data)
      } catch {}
    }
  })

  // Corestore lives under the app's document directory (file:// stripped).
  const dataDir = FileSystem.documentDirectory!.replace(/^file:\/\//, '').replace(/\/$/, '')
  await callRaw('init', { dataDir })
}
export async function ensureBackendStarted () { await startWorklet() }

// --- UI html ---------------------------------------------------------------
function buildHtml (jsBundle: string) {
  const platform = JSON.stringify(Platform.OS)
  const debug = JSON.stringify(__DEV__)
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" /><style>html,body,#root{height:100%;margin:0;padding:0;background:#0d0d0d}body{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}</style><script>window.__pearPlatform=${platform};window.__pearDebug=${debug};</script></head><body><div id="root"></div><script>${jsBundle}</script></body></html>`
}
async function loadUiHtml () {
  const asset = Asset.fromModule(require('../assets/app-ui.bundle'))
  await asset.downloadAsync()
  const js = await FileSystem.readAsStringAsync(asset.localUri!, { encoding: FileSystem.EncodingType.UTF8 })
  return buildHtml(js)
}

// The invite payload rides in the URL fragment (#) or, as a fallback, a query
// (?). Match either so a fragment-only link is still recognized and forwarded.
const INVITE_RE = /^(pear:\/\/pearlist\/join|https:\/\/peerloomllc\.com\/pearlist\/join)\/?[?#]/

export default function Shell () {
  const webViewRef = useRef<any>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [statusBarStyle, setStatusBarStyle] = useState<'light-content' | 'dark-content'>('light-content')
  const webViewLoaded = useRef(false)
  const pendingDeeplink = useRef<string | null>(null)
  const canBackRef = useRef(false) // set by shell:navState; drives the back button
  const insets = useSafeAreaInsets()

  useEffect(() => { _webViewRef = webViewRef })

  // Feed the real device safe-area insets to the WebView as CSS vars. Android
  // WebView reports env(safe-area-inset-*) as 0, so without this the top bar
  // hides under the status bar / notch.
  const injectInsets = () => {
    webViewRef.current?.injectJavaScript(
      `(function(){var d=document.documentElement.style;` +
      `d.setProperty('--pear-safe-top','${insets.top}px');` +
      `d.setProperty('--pear-safe-bottom','${insets.bottom}px');` +
      `d.setProperty('--pear-safe-left','${insets.left}px');` +
      `d.setProperty('--pear-safe-right','${insets.right}px');})(); true;`
    )
  }
  useEffect(() => { if (webViewLoaded.current) injectInsets() }, [insets.top, insets.bottom, insets.left, insets.right])

  useEffect(() => {
    (async () => {
      await startWorklet() // init the worklet (with dataDir) before the WebView can call it
      setHtml(await loadUiHtml())
    })().catch((e) => console.warn('shell boot failed', e?.message ?? String(e)))
  }, [])

  // Android hardware back / gesture: if the WebView reported an open overlay
  // (sheet, full-screen view, list detail), forward a 'back' event for it to
  // dismiss and consume the press; otherwise let the OS exit the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canBackRef.current) { emitEvent('back'); return true }
      return false
    })
    return () => sub.remove()
  }, [])

  // Deep-link invite delivery (buffer until the WebView has mounted).
  useEffect(() => {
    const deliver = (url: string) => {
      if (webViewLoaded.current) emitEvent('deeplink:invite', { url })
      else pendingDeeplink.current = url
    }
    Linking.getInitialURL().then((url) => { if (url && INVITE_RE.test(url)) deliver(url) })
    const sub = Linking.addEventListener('url', ({ url }) => { if (INVITE_RE.test(url)) deliver(url) })
    return () => sub.remove()
  }, [])

  // Response shape matches the UI bridge (src/ui/ipc.js): __pearResponse(msg).
  const reply = (id: number, result: any) =>
    webViewRef.current?.injectJavaScript(`window.__pearResponse(${JSON.stringify({ id, result: result ?? null })}); true;`)
  const replyError = (id: number, error: any) =>
    webViewRef.current?.injectJavaScript(`window.__pearResponse(${JSON.stringify({ id, error: String(error) })}); true;`)

  const onMessage = async (e: any) => {
    let msg: any
    try { msg = JSON.parse(e.nativeEvent.data) } catch { return }
    const { id, method, args } = msg
    try {
      switch (method) {
        case 'shell:share': {
          const res = await Share.share({ message: args?.text ?? '', title: args?.title ?? '' })
          return reply(id, { ok: res.action !== Share.dismissedAction })
        }
        case 'shell:openUrl': {
          if (!args?.url) return replyError(id, 'url required')
          await Linking.openURL(args.url); return reply(id, { ok: true })
        }
        case 'shell:canOpenURL': {
          const can = await Linking.canOpenURL(args?.url ?? '').catch(() => false)
          return reply(id, { ok: true, can: !!can })
        }
        case 'shell:haptic': {
          const k = args?.kind
          try {
            if (k === 'light') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
            else if (k === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
            else if (k === 'heavy') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
            else if (k === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
            else if (k === 'warn') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          } catch {}
          return reply(id, { ok: true })
        }
        case 'shell:theme:get': {
          const raw = await AsyncStorage.getItem('pearlist:theme')
          return reply(id, { theme: raw === 'light' ? 'light' : 'dark' })
        }
        case 'shell:theme:set': {
          const t = args?.theme
          if (t !== 'dark' && t !== 'light') return replyError(id, "theme must be 'dark' or 'light'")
          await AsyncStorage.setItem('pearlist:theme', t); return reply(id, { ok: true })
        }
        case 'shell:navState': {
          canBackRef.current = !!args?.canBack
          return reply(id, { ok: true })
        }
        case 'shell:statusBar:set': {
          if (args?.style === 'dark') setStatusBarStyle('dark-content')
          else if (args?.style === 'light') setStatusBarStyle('light-content')
          return reply(id, { ok: true })
        }
        default: {
          // Everything else goes to the worklet.
          const wm = await callRaw(method, args)
          if (wm && wm.error != null) return replyError(id, wm.error)
          return reply(id, wm ? wm.result : null)
        }
      }
    } catch (err: any) {
      replyError(id, err?.message ?? String(err))
    }
  }

  const onLoad = () => {
    webViewLoaded.current = true
    injectInsets()
    if (pendingDeeplink.current) {
      emitEvent('deeplink:invite', { url: pendingDeeplink.current })
      pendingDeeplink.current = null
    }
  }

  if (!html) return <View style={{ flex: 1, backgroundColor: '#0d0d0d' }} />
  return (
    <>
      <StatusBar barStyle={statusBarStyle} translucent backgroundColor='transparent' />
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: 'https://localhost/' }}
        onMessage={onMessage}
        onLoad={onLoad}
        style={{ flex: 1, backgroundColor: '#0d0d0d' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        // In-WebView camera for the QR scanner (getUserMedia). Not in PearCircle
        // (it scans natively); the https://localhost/ baseUrl gives the secure
        // context getUserMedia requires.
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType='grant'
        onPermissionRequest={(ev: any) => { try { ev?.grant?.(ev.resources) } catch {} }}
      />
    </>
  )
}
