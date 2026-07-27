// PearList shell: hosts the Bare worklet (P2P backend) and the WebView UI, and
// bridges IPC between them. No custom native code - the worklet and WebView are
// pure RN libraries. Mirrors PearCircle's shell minus the location stack; adds
// WebView camera permission for the in-WebView QR scanner.

import { useEffect, useRef, useState } from 'react'
import { View, Platform, Share, StatusBar, BackHandler, AppState } from 'react-native'
import { WebView } from 'react-native-webview'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import * as Device from 'expo-device'
import * as Linking from 'expo-linking'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { requestLocalNetworkPermission } from '../modules/local-network'
import { startBackgroundSync, stopBackgroundSync, bgSyncSupported } from '../modules/bg-sync'
import { terminateWebViewRenderer } from '../modules/webview-recovery'

// --- local notifications (assignment + join + completion; ON by default) ----
// Policy: assignment + join + chore-completion, LOCAL (no server/push), ON by
// default (permission requested on first run; user can turn it off in Profile).
// The worklet emits notify:* when it applies a fresh peer change; the shell
// raises an OS notification if the user has it enabled. Suppress the OS banner
// while the
// app is foreground (the WebView shows its own in-app banner); the OS still
// shows it when we are backgrounded. No background sync yet, so this fires while
// the app is running (foreground + its brief background window).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
})

const NOTIF_KEY = 'pearlist:notifications'
let _notifEnabled = false
async function loadNotifEnabled () {
  let stored: string | null = null
  try { stored = await AsyncStorage.getItem(NOTIF_KEY) } catch { stored = null }
  if (stored === null) {
    // On by default: on first run request the OS permission and enable if
    // granted. Persist the result so a later explicit toggle-off is honored and
    // we never re-prompt on our own.
    try {
      await ensureNotifPermission()
      _notifEnabled = (await Notifications.getPermissionsAsync()).status === 'granted'
      await AsyncStorage.setItem(NOTIF_KEY, _notifEnabled ? '1' : '0')
    } catch { _notifEnabled = false }
  } else {
    _notifEnabled = stored === '1'
  }
  return _notifEnabled
}
async function ensureNotifPermission () {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('assignment', {
      name: 'Item assignments', importance: Notifications.AndroidImportance.DEFAULT,
      description: 'When someone assigns you an item',
    })
    await Notifications.setNotificationChannelAsync('membership', {
      name: 'Space membership', importance: Notifications.AndroidImportance.DEFAULT,
      description: 'When someone joins a space',
    })
    await Notifications.setNotificationChannelAsync('completion', {
      name: 'Completed items', importance: Notifications.AndroidImportance.DEFAULT,
      description: 'When someone completes an item on a list you oversee',
    })
    // Its own channel so a daily nudge can be muted without muting the alerts
    // that follow something a person actually did.
    await Notifications.setNotificationChannelAsync('reminder', {
      name: 'Daily reminder', importance: Notifications.AndroidImportance.DEFAULT,
      description: 'A once-a-day nudge about lists with open items',
    })
  }
  const s = await Notifications.getPermissionsAsync()
  if (s.status !== 'granted') await Notifications.requestPermissionsAsync()
}
// --- background sync opt-in (Android foreground service; default ON) --------
const BGSYNC_KEY = 'pearlist:bgsync'
async function bgSyncEnabled (): Promise<boolean> {
  if (!bgSyncSupported) return false
  try { const v = await AsyncStorage.getItem(BGSYNC_KEY); return v === null ? true : v === '1' } catch { return true }
}

function fireNotify (channelId: string, title: string, body: string, data?: any) {
  if (!_notifEnabled) return
  Notifications.scheduleNotificationAsync({
    content: { title, body, data: data || {}, ...(Platform.OS === 'android' ? { channelId } : {}) },
    trigger: null, // deliver now
  }).catch(() => {})
}

// --- daily reminder (P1 of proposals/2026-07-27-reminder-notifications.md) ---
//
// Unlike every other notification here, this one is TIME-triggered: it is handed
// to the OS in advance and the OS delivers it whether or not our process exists.
// That is why it works on iOS, where the peer-driven notifications cannot (see
// DECISIONS 2026-07-07). Nothing crosses the wire, nothing wakes the worklet.
//
// Device-local like the notification and bg-sync toggles. NOT synced: syncing it
// would mean one member's 07:00 nudge waking the whole household.
const REMINDER_KEY = 'pearlist:dailyReminder'
const REMINDER_ID = 'pearlist:daily' // stable, so re-scheduling replaces rather than stacks
type ReminderPref = { enabled: boolean, hour: number, minute: number }
// OFF by default, deliberately NOT following the 2026-07-07 "notifications ON by
// default" reversal. Those fire because a person just did something; an
// unsolicited daily buzz nobody asked for is the classic uninstall trigger.
const REMINDER_DEFAULT: ReminderPref = { enabled: false, hour: 18, minute: 0 }

function clampHour (n: any) { return Math.min(23, Math.max(0, Math.trunc(Number(n)) || 0)) }
function clampMinute (n: any) { return Math.min(59, Math.max(0, Math.trunc(Number(n)) || 0)) }

async function loadReminderPref (): Promise<ReminderPref> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY)
    if (!raw) return REMINDER_DEFAULT
    const p = JSON.parse(raw)
    return { enabled: !!p?.enabled, hour: clampHour(p?.hour), minute: clampMinute(p?.minute) }
  } catch { return REMINDER_DEFAULT }
}

// Re-derive the scheduled reminder from the current open counts. Idempotent, so
// calling it too often is free - which is what lets every trigger below just call
// it without reasoning about ordering.
//
// The bail-outs deliberately differ. "It should not exist" CANCELS; "I cannot
// tell right now" LEAVES WHAT IS SCHEDULED ALONE. Cancelling on a failed read
// would silently drop the reminder for the day.
async function refreshDailyReminder () {
  try {
    const pref = await loadReminderPref()
    if (!pref.enabled || !_notifEnabled) {
      await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => {})
      return
    }
    if (!_workletStarted) return // too early to know the counts
    // callRaw never rejects and never times out, so a wedged worklet would hang
    // here forever - and shell:reminder:set awaits this before replying, which
    // would freeze the Settings toggle. Bound it and keep the existing schedule.
    const TIMED_OUT = Symbol('timeout')
    const wm: any = await Promise.race([
      callRaw('list:openSummary', {}),
      new Promise((res) => setTimeout(() => res(TIMED_OUT), 5000)),
    ])
    if (wm === TIMED_OUT) return
    const digest = wm?.result?.digest
    // A null digest means nothing is open. Cancel rather than schedule a daily
    // "you have nothing to do", which is pure noise. The next launch, foreground
    // or backgrounding puts it back as soon as something is open again.
    if (!digest?.body) {
      await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => {})
      return
    }
    // Same identifier, so this REPLACES rather than stacking a second daily.
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: {
        title: digest.title, body: digest.body,
        data: { groupId: digest.groupId, listId: digest.listId }, // tap -> open the top list
        ...(Platform.OS === 'android' ? { channelId: 'reminder' } : {}),
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: pref.hour, minute: pref.minute },
    })
  } catch {}
}

// How long the app must have been backgrounded before a resume terminates the
// WebView's render process (GrapheneOS/Vanadium freeze recovery; see the AppState
// effect below). The recovery costs a WebView reload, roughly 1-2s and a scroll
// reset, so this gate keeps quick app-switches free. Raise it if that reload
// starts feeling too eager.
const WEBVIEW_RECOVERY_MIN_BG_MS = 20_000

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

// ONE-TIME RECLAIM for anyone who enabled the on-device AI before it was removed.
// The model was ~0.8 GB in the SDK's own store under Documents/.qvac, and removing
// the feature does not remove the bytes - leaving them would silently keep that
// space for a feature the app no longer has. Deleted directly rather than through
// the SDK, because the whole point is that nothing imports @qvac any more. The
// AsyncStorage flags go too, so a stale "model ready" cannot outlive the model.
// Runs once, guarded by a flag; harmless on a device that never enabled it.
const AI_PURGED_KEY = 'pearlist:aiPurged'
async function purgeRemovedAiModel () {
  try {
    if ((await AsyncStorage.getItem(AI_PURGED_KEY)) === '1') return
    await FileSystem.deleteAsync(FileSystem.documentDirectory + '.qvac', { idempotent: true }).catch(() => {})
    await AsyncStorage.multiRemove(['qvac:consent', 'qvac:modelReady']).catch(() => {})
    await AsyncStorage.setItem(AI_PURGED_KEY, '1')
  } catch {}
}

// Diagnostic: tee the worklet's pairing trace to Documents/pair-trace.log so we
// can pull it off an iOS device (worklet console.warn does not reach a remote
// shell there). The worklet re-ships the full buffer each mark, so we overwrite
// (not append) to keep the file to the latest complete trace. Fire-and-forget.
function writePairTrace (lines?: string[]) {
  if (!Array.isArray(lines)) return
  const path = FileSystem.documentDirectory + 'pair-trace.log'
  FileSystem.writeAsStringAsync(path, lines.join('\n') + '\n').catch(() => {})
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
        else if (msg.event === 'pair:trace') writePairTrace(msg.data?.lines)
        else if (msg.event === 'notify:assigned') {
          const isList = msg.data?.kind === 'list'
          const text = msg.data?.text ?? (isList ? 'a list' : 'an item')
          fireNotify('assignment',
            isList ? 'List assigned to you' : 'Assigned to you',
            isList ? `You were assigned the list "${text}"` : `You were assigned "${text}"`,
            { groupId: msg.data?.groupId, listId: msg.data?.listId }) // tap -> open the list
          emitEvent('notify:assigned', msg.data) // WebView shows an in-app banner too
        }
        else if (msg.event === 'notify:joined') {
          fireNotify('membership', 'Someone joined', `${msg.data?.name ?? 'Someone'} joined a space`,
            { groupId: msg.data?.groupId }) // tap -> open the space
          // join already surfaces in-app via the roster diff; no WebView forward
        }
        else if (msg.event === 'notify:completed') {
          const allDone = !!msg.data?.allDone
          const listLabel = msg.data?.kind === 'chore' ? 'Chore list' : 'List'
          const listName = msg.data?.listName ?? 'a list'
          fireNotify('completion',
            allDone ? 'All done' : 'Item completed',
            allDone
              ? `${listLabel} "${listName}" is all done`
              : `"${msg.data?.item ?? 'an item'}" was completed in "${listName}"`,
            { groupId: msg.data?.groupId, listId: msg.data?.listId }) // tap -> open the list
          emitEvent('notify:completed', msg.data) // WebView shows an in-app banner too
        }
        else if (msg.event) emitEvent(msg.event, msg.data)
      } catch {}
    }
  })

  // Corestore lives under the app's document directory (file:// stripped).
  const dataDir = FileSystem.documentDirectory!.replace(/^file:\/\//, '').replace(/\/$/, '')
  await callRaw('init', { dataDir })
}
export async function ensureBackendStarted () { await startWorklet() }

// Screenshot capture: the store-screenshot scripts cold-launch the app with a
// pear://pearlist/screenshot/<N> deep link. Parse the scene number so the shell
// can inject it into the WebView before the UI bundle runs (see buildHtml). No
// effect in normal use - only the capture scripts ever send that URL.
function parseScreenshotScene (url: string | null): number | null {
  if (!url) return null
  const m = url.match(/^pear:\/\/pearlist\/screenshot\/(\d+)/i) || url.match(/[?&]__screenshotScene=(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

// iOS screenshot delivery: the driver writes the scene number into the app's
// Documents dir before launching (simctl openurl on a custom scheme shows an
// "Open in ...?" confirmation that would cover the frame, so we avoid it). No
// effect in normal use - the file only exists during a capture run.
async function readScreenshotSceneFile (): Promise<number | null> {
  try {
    const txt = await FileSystem.readAsStringAsync(FileSystem.documentDirectory + 'screenshot-scene')
    const n = parseInt(String(txt).trim(), 10)
    return Number.isInteger(n) ? n : null
  } catch { return null }
}

// --- UI html ---------------------------------------------------------------
function buildHtml (jsBundle: string, screenshotScene?: number | null) {
  const platform = JSON.stringify(Platform.OS)
  const debug = JSON.stringify(__DEV__)
  const shot = screenshotScene != null ? `window.__PEARLIST_SCREENSHOT_SCENE=${JSON.stringify(screenshotScene)};` : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" /><style>html,body,#root{height:100%;margin:0;padding:0;background:#0d0d0d}body{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}</style><script>window.__pearPlatform=${platform};window.__pearDebug=${debug};${shot}</script></head><body><div id="root"></div><script>${jsBundle}</script></body></html>`
}
async function loadUiHtml (screenshotScene?: number | null) {
  const asset = Asset.fromModule(require('../assets/app-ui.bundle'))
  await asset.downloadAsync()
  const js = await FileSystem.readAsStringAsync(asset.localUri!, { encoding: FileSystem.EncodingType.UTF8 })
  return buildHtml(js, screenshotScene)
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
  const pendingNotifNav = useRef<any>(null) // notification-tap target, buffered until the WebView mounts
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
    let cancelled = false
    ;(async () => {
      // Screenshot capture: if launched via pear://pearlist/screenshot/<N>, the
      // UI runs from fixtures (see src/ui/screenshot-fixtures.js). Skip the
      // worklet and every permission prompt, which would otherwise cover the
      // captured frame (iOS Local Network, notifications, etc.).
      const initialUrl = await Linking.getInitialURL().catch(() => null)
      const scene = (await readScreenshotSceneFile()) ?? parseScreenshotScene(initialUrl)
      if (scene != null) {
        if (!cancelled) setHtml(await loadUiHtml(scene))
        return
      }
      purgeRemovedAiModel() // reclaim the old model's ~0.8 GB, once
      // Nudge iOS to show the Local Network prompt so same-WiFi peers connect
      // directly (see modules/local-network). Fire-and-forget; no-op off iOS.
      requestLocalNetworkPermission()
      // Notifications are ON by default: this requests the OS permission on first
      // run (and gates fireNotify from boot). Awaited before bgsync so the two
      // paths do not race on the permission prompt.
      await loadNotifEnabled()
      // Keep-syncing-in-background (Android, default ON): start the foreground
      // service so the worklet stays connected while backgrounded. Ensure the
      // notification permission first (the service needs a visible notification).
      bgSyncEnabled().then((on) => { if (on) ensureNotifPermission().finally(startBackgroundSync) })
      await startWorklet() // init the worklet (with dataDir) before the WebView can call it
      // Now that the worklet can answer list:openSummary, re-derive the daily
      // reminder from the current open counts. Its body was frozen whenever it
      // was last scheduled, so a launch is the cheapest moment to refresh it.
      refreshDailyReminder()
      if (!cancelled) setHtml(await loadUiHtml())
    })().catch((e) => console.warn('shell boot failed', e?.message ?? String(e)))
    return () => { cancelled = true }
  }, [])

  // Keep the daily reminder's copy honest. Its body is frozen when it is
  // scheduled, so refresh it at the two moments the counts are known to be
  // current: when we come back to the foreground, and when we are about to lose
  // the ability to update it at all.
  //
  // Backgrounding is the important one on iOS. There the app may not run again
  // before the reminder fires, so whatever we schedule on the way out is what the
  // user sees. Cross-platform on purpose, unlike the Android-only WebView
  // recovery effect below.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' || state === 'background') refreshDailyReminder()
    })
    return () => sub.remove()
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

  // Notification tap -> open the related space/list. Buffer until the WebView has
  // mounted (covers cold start via getLastNotificationResponseAsync).
  useEffect(() => {
    const deliverNav = (data: any) => {
      if (!data || !data.groupId) return
      const nav = { groupId: data.groupId, listId: data.listId ?? null }
      if (webViewLoaded.current) emitEvent('notify:open', nav)
      else pendingNotifNav.current = nav
    }
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => { if (resp) deliverNav(resp.notification.request.content.data) })
      .catch(() => {})
    const sub = Notifications.addNotificationResponseReceivedListener(
      (resp) => deliverNav(resp.notification.request.content.data)
    )
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
        case 'shell:clipboard': {
          // Copy to the OS clipboard. navigator.clipboard is unreliable in the
          // about:blank WebView, so the donation sheet routes copies through here.
          const text = args?.text
          if (typeof text !== 'string' || text.length === 0) {
            return reply(id, { ok: false, error: 'text must be a non-empty string' })
          }
          try {
            await Clipboard.setStringAsync(text)
            return reply(id, { ok: true })
          } catch (err: any) {
            return reply(id, { ok: false, error: err?.message ?? String(err) })
          }
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
        case 'shell:bgsync:get': {
          return reply(id, { supported: bgSyncSupported, enabled: await bgSyncEnabled() })
        }
        case 'shell:bgsync:set': {
          const on = !!args?.enabled
          await AsyncStorage.setItem(BGSYNC_KEY, on ? '1' : '0')
          if (on) { await ensureNotifPermission(); startBackgroundSync() } else stopBackgroundSync()
          return reply(id, { supported: bgSyncSupported, enabled: on })
        }
        case 'shell:notifications:get': {
          return reply(id, { enabled: _notifEnabled })
        }
        case 'shell:notifications:set': {
          const enabled = !!args?.enabled
          if (enabled) await ensureNotifPermission()
          // Reflect the actual OS permission: if the user declined, stay off.
          const granted = enabled ? (await Notifications.getPermissionsAsync()).status === 'granted' : false
          _notifEnabled = enabled && granted
          await AsyncStorage.setItem(NOTIF_KEY, _notifEnabled ? '1' : '0')
          // The master toggle gates the daily reminder too, so turning it off must
          // cancel a scheduled one rather than leave it to fire from the OS.
          refreshDailyReminder()
          return reply(id, { enabled: _notifEnabled, permissionDenied: enabled && !granted })
        }
        case 'shell:reminder:get': {
          return reply(id, await loadReminderPref())
        }
        case 'shell:reminder:set': {
          const pref: ReminderPref = {
            enabled: !!args?.enabled, hour: clampHour(args?.hour), minute: clampMinute(args?.minute),
          }
          // Make sure the 'reminder' Android channel exists before anything is
          // scheduled onto it. Only when notifications are actually on: prompting
          // the OS for a permission we would not use is noise, and the reply below
          // already tells the UI why nothing was scheduled.
          if (pref.enabled && _notifEnabled) await ensureNotifPermission()
          await AsyncStorage.setItem(REMINDER_KEY, JSON.stringify(pref))
          await refreshDailyReminder()
          // Report what actually happened: enabled but not notifEnabled means the
          // OS permission was declined, and the UI says so rather than lying.
          return reply(id, { ...pref, notificationsEnabled: _notifEnabled })
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
        // The on-device AI was removed in 1.0.4 (see DECISIONS). Measured over 1702
        // calls it placed 37% of the items that reached it correctly, at 4-6.5s each,
        // for a 0.8 GB download and 2 GB resident - so unknown items now simply rest
        // in Other, where the keyword pass leaves them. Nothing here imports @qvac.
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

  // GrapheneOS/Vanadium resume-freeze recovery, Android only. See
  // modules/webview-recovery and WEBVIEW_FREEZE_FIX_PORT.md.
  //
  // The cached-app freezer freezes the WebView's out-of-process renderer while we
  // are backgrounded; since Vanadium 151 (2026-07-19) it comes back thawed but
  // never re-attaches its compositor to the new window surface, so the UI is
  // frozen even though JS and touch still work. Terminating the renderer on
  // resume forces a fresh one, and onRenderProcessGone below reloads into it.
  //
  // Gated on a minimum background duration: a quick app-switch never hit the
  // freezer, so reloading then would cost a visible reload for nothing.
  const backgroundedAt = useRef(0)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        if (backgroundedAt.current === 0) backgroundedAt.current = Date.now()
        return
      }
      if (state !== 'active') return
      const backgroundedFor = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0
      backgroundedAt.current = 0
      if (backgroundedFor >= WEBVIEW_RECOVERY_MIN_BG_MS) terminateWebViewRenderer()
      // Android 15+ allows only 6h of dataSync foreground service per 24h. When
      // that runs out the service stops itself (see BgSyncService.onTimeout), and
      // the allowance resets precisely when the app is foregrounded - here. Re-arm
      // so background sync resumes instead of staying dead until the next launch.
      // startBackgroundSync is a no-op if it is already running and never throws.
      bgSyncEnabled().then((on) => { if (on) startBackgroundSync() })
    })
    return () => sub.remove()
  }, [])

  const onLoad = () => {
    webViewLoaded.current = true
    injectInsets()
    if (pendingDeeplink.current) {
      emitEvent('deeplink:invite', { url: pendingDeeplink.current })
      pendingDeeplink.current = null
    }
    if (pendingNotifNav.current) {
      emitEvent('notify:open', pendingNotifNav.current)
      pendingNotifNav.current = null
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
        // The other half of the resume-freeze recovery above: reload into the
        // fresh render process. didCrash=false is our own deliberate terminate;
        // didCrash=true is a real renderer crash, and reloading is the right
        // response to both. webViewLoaded is reset so queued IPC waits for the
        // reloaded UI rather than being injected into a dead page.
        onRenderProcessGone={(e: any) => {
          console.warn('[webview] render process gone, didCrash=' + e?.nativeEvent?.didCrash + ' -> reload')
          webViewLoaded.current = false
          webViewRef.current?.reload()
        }}
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
