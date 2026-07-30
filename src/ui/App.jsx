import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { call, on, isMock, haptic } from './ipc.js'
import { SCREENSHOT_SCENE, SCREENSHOT_ROUTE } from './screenshot-fixtures.js'
import { colors as c, spacing as sp, radius as r, FONT, MONO, setTheme, loadTheme } from './theme.js'
import { APP_ICON } from './appIcon.js'
import aisles from '../aisles.js'
import { sortNoteRows, splitLines, joinLines } from '../noteText.js'
import { nextCollapseState } from '../autoCollapse.js'
import { pairLinkProblem } from '../linkShape.js'
import { problem, terminated } from '../userText.js'
import { syncTrouble } from '../syncStatus.js'
import { itemPresets, dailyPresets, describeWhen, stepDays, stepMinutes, defaultExact } from '../reminderPresets.js'
import { ShareNetwork, Trash, Link, CaretRight, CaretLeft, CaretDown, X, Check, Plus, Minus, DotsThree, DotsSixVertical, ShoppingCart, Broom, ListChecks, ListBullets, Note, Lightning, CheckCircle, ArrowSquareOut, Info, GearSix, House, Sparkle, BellRinging, ArrowsClockwise, DeviceMobile, UsersThree, UserMinus, SignOut } from '@phosphor-icons/react'

// Single-sourced from app.json's expo.version: scripts/build-ui.mjs substitutes
// __APP_VERSION__ at bundle time, and every release rebuilds the bundle (release.sh
// runs `npm run verify` -> build:ui), so the number on the Settings screen cannot
// drift from the shipped one. The typeof guard keeps a bundler that does not
// define it from crashing the whole UI on an undefined global.
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
// Suite donation config (shared across PeerLoom apps). See the canonical spec at
// peerloomllc/patterns/btc-donation-sheet.md; constants are identical everywhere.
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/'
// Strike deposit address (custodial, derived from Strike's xpub, so reuse is
// fine). Empty string hides the on-chain row. Rotate here in one line.
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf'
// Shared height so every option box (buttons, copy fields, wallet rows) lines up.
const DONATE_OPTION_MIN_H = 56
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const LIGHTNING_WALLETS = [
  { name: 'Strike', url: 'https://strike.me', desc: 'Simple Lightning payments' },
  { name: 'Cash App', url: 'https://cash.app', desc: 'Send Bitcoin via Lightning' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com', desc: 'Beginner-friendly Lightning wallet' },
  { name: 'Phoenix', url: 'https://phoenix.acinq.co', desc: 'Self-custodial Lightning wallet' },
]
// The shell injects window.__pearPlatform ('ios'|'android') before the bundle.
// (The donation UI used to be hidden on iOS pending the App Store release; it now
// ships on both platforms, so the only caller left is the tour's platform slide.)
const isIOS = () => typeof window !== 'undefined' && window.__pearPlatform === 'ios'

const openUrl = (url) => { try { call('shell:openUrl', { url }) } catch {} }

// List categories. The `kind` field on a list row (see listWire.js LIST_KINDS)
// drives its icon, color, and the Lists-page section it groups under. Array
// order is the section display order; the generic 'list' is the default + last.
//
// 'note' is the odd one out: it is not a checklist at all, it opens a NoteEditor
// instead of an item list (see noteText.js). Its colour is its own `c.note`
// token rather than a reused one - the 2026-07-13 c.accent audit found the
// palette's four list colours are all doing distinguishing work in a now
// five-way selector, so a fifth kind needs a fifth colour.
const CATEGORIES = [
  { key: 'grocery', label: 'Shopping', section: 'Shopping', Icon: ShoppingCart, color: c.success },
  { key: 'chore', label: 'Chores', section: 'Chores', Icon: Broom, color: c.warn },
  { key: 'todo', label: 'To-dos', section: 'To-dos', Icon: ListChecks, color: c.accent },
  { key: 'note', label: 'Note', section: 'Notes', Icon: Note, color: c.note },
  { key: 'list', label: 'List', section: 'Lists', Icon: ListBullets, color: c.text.muted },
]
const categoryOf = (kind) => CATEGORIES.find((x) => x.key === kind) || CATEGORIES[CATEGORIES.length - 1]

// Completion-notification modes (see listWire.js). When someone checks items on
// a list, its overseer (list.assignee) is notified per this mode. Absent ->
// derive: chore lists default to 'done', everything else to 'off'.
const NOTIFY_MODES = [
  { key: 'done', label: 'When all done', hint: 'One alert when the last item is checked' },
  { key: 'each', label: 'Every completion', hint: 'An alert each time an item is checked' },
  { key: 'off', label: 'Off', hint: 'No completion alerts' },
]
const notifyModeOf = (key) => NOTIFY_MODES.find((m) => m.key === key) || NOTIFY_MODES[0]
const effectiveNotifyMode = (list) => (['off', 'each', 'done'].includes(list?.notifyOnComplete) ? list.notifyOnComplete : (list?.kind === 'chore' ? 'done' : 'off'))

// Invite links. The raw invite is an opaque base64url blob (from the core
// encoder); we present it as a real https link so a plain text/QR share opens
// the app via the deep-link intent filter (see app.json). The blob rides in the
// URL fragment so it never reaches peerloomllc.com's server (it grants access).
const INVITE_URL_BASE = 'https://peerloomllc.com/pearlist/join'
function inviteUrl (key) { return key ? `${INVITE_URL_BASE}#${key}` : '' }
// Accept a pasted/scanned/deep-linked invite in any shape: a full https/pear
// URL (blob in the #fragment, an ?i= query, or after /join) or a bare blob.
function parseInvite (text) {
  const s = String(text || '').trim()
  if (/^(https?:|pear:)/i.test(s)) {
    const h = s.indexOf('#'); if (h !== -1) return s.slice(h + 1).trim()
    const m = s.match(/[?&]i=([^&#]+)/); if (m) return decodeURIComponent(m[1]).trim()
    const j = s.indexOf('/join'); if (j !== -1) return s.slice(j + 5).replace(/^[/?#]+/, '').trim()
    return ''
  }
  return s
}

// One name for a linked device, used by the roster and by the Settings summary
// line so the two cannot disagree. `platform` is device-link's own fallback and
// is a bare string like "android"; `fallback` lets the rename field start EMPTY
// rather than pre-filled with a placeholder the user would have to clear first.
function deviceLabel (d, fallback = 'Unnamed device') {
  if (!d) return fallback
  return (d.nickname && String(d.nickname).trim()) || d.platform || fallback
}

function initialsFor (label) {
  const s = (label || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase()
}
// Cap for an animated (gif/webp) avatar kept as raw base64. Static photos are
// downscaled far below this. Base64 inflates ~4/3, so the worklet's stored-value
// cap must clear this * 1.4.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
function avatarSrc (avatar) {
  if (typeof avatar !== 'string' || !avatar) return null
  return avatar.startsWith('data:') ? avatar : 'data:image/jpeg;base64,' + avatar
}
function readFileDataUrl (file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}
// Downscale + re-encode to keep the avatar small (stored inline in the profile).
function compressToAvatar (dataUrl, max = 256, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale); const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = reject
    img.src = dataUrl
  })
}

// ---------------------------------------------------------------------------
// Shared primitives (mirrors the suite: pill buttons radius 10, centered
// back-bar titles, bottom-sheet with grab handle + 280ms slide).
// ---------------------------------------------------------------------------

function Spinner ({ size = 22 }) {
  return <div style={{ width: size, height: size, border: `2px solid ${c.border}`, borderTopColor: c.primary, borderRadius: '50%', animation: 'pearlist-spin 0.7s linear infinite' }} />
}

// Haptics are applied globally by a delegated click listener (see App), so
// individual controls need no per-onClick wiring. `data-haptic` opts an element
// into a stronger cue ('warn' for destructive, 'success' for completing).
function Button ({ variant = 'primary', children, style, ...rest }) {
  const base = { width: '100%', padding: '14px 16px', borderRadius: r.lg, fontSize: 16, fontWeight: 400, cursor: 'pointer', fontFamily: FONT }
  const variants = {
    primary: { background: c.primary, color: c.text.onPrimary, border: 'none' },
    secondary: { background: c.surface.input, color: c.text.primary, border: `1px solid ${c.text.muted}` },
    danger: { background: c.error, color: '#000', border: 'none' },
  }
  return <button data-haptic={variant === 'danger' ? 'warn' : undefined} style={{ ...base, ...variants[variant], ...style }} {...rest}>{children}</button>
}

function IconButton ({ children, label, style, ...rest }) {
  return <button aria-label={label} style={{ width: 36, height: 36, padding: 0, background: 'none', color: c.text.secondary, border: 'none', fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }} {...rest}>{children}</button>
}

function TopBar ({ title, left, right }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `calc(var(--pear-safe-top) + ${sp.md}px) calc(var(--pear-safe-right) + ${sp.base}px) ${sp.md}px calc(var(--pear-safe-left) + ${sp.base}px)`, borderBottom: `1px solid ${c.border}`, background: c.surface.base, position: 'sticky', top: 0, zIndex: 5 }}>
      <div style={{ width: 36, display: 'flex' }}>{left || null}</div>
      <h1 style={{ flex: 1, textAlign: 'center', fontSize: 20, fontWeight: 400, margin: 0, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
      <div style={{ width: 36, display: 'flex', justifyContent: 'flex-end' }}>{right || null}</div>
    </header>
  )
}

function Field ({ value, onChange, placeholder, onEnter, autoFocus }) {
  return (
    <input
      value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter() }}
      style={{ width: '100%', padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none' }}
    />
  )
}

function BottomSheet ({ open, onClose, title, children }) {
  const [render, setRender] = useState(open)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) { setRender(true); const t = setTimeout(() => setShown(true), 20); return () => clearTimeout(t) }
    setShown(false); const t = setTimeout(() => setRender(false), 280); return () => clearTimeout(t)
  }, [open])
  if (!render) return null
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: shown ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)', transition: 'background 280ms ease', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 600, background: c.surface.card, borderRadius: `${r.sheet}px ${r.sheet}px 0 0`, maxHeight: '85dvh', overflowY: 'auto', transform: shown ? 'translateY(0)' : 'translateY(100%)', transition: 'transform 280ms cubic-bezier(0.32,0.72,0,1)', padding: `${sp.sm}px ${sp.lg}px calc(var(--pear-safe-bottom) + ${sp.xl}px)` }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: c.text.muted, margin: '6px auto 14px' }} />
        {title ? <h2 style={{ textAlign: 'center', fontSize: 17, fontWeight: 400, margin: `0 0 ${sp.base}px`, color: c.text.primary }}>{title}</h2> : null}
        {children}
      </div>
    </div>
  )
}

// --- reminder time pickers ---------------------------------------------------
// Ours, not the OS one. The system pickers cannot be themed, look different on
// each platform, and make you spin a wheel to say "tomorrow morning". These are
// plain buttons in the app's own type and colour, identical everywhere, and a
// screen reader reads them as what they are.
//
// The exact-time fallback is steppers rather than a rebuilt wheel: no drag
// gesture to tune, and every control is a labelled button. Time maths lives in
// src/reminderPresets.js, which is pure and unit-tested.

function PresetRow ({ label, detail, onClick, danger }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: sp.md, padding: '14px 16px', marginBottom: sp.sm, background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, cursor: 'pointer', textAlign: 'left', fontFamily: FONT }}>
      <span style={{ color: danger ? c.error : c.text.primary, fontSize: 16, fontWeight: 300 }}>{label}</span>
      {detail ? <span style={{ color: c.text.muted, fontSize: 13, flexShrink: 0 }}>{detail}</span> : null}
    </button>
  )
}

// One labelled value with a minus and a plus. Used for both the day and the time
// so they read as the same control.
function Stepper ({ label, value, onStep }) {
  const btn = { width: 44, height: 44, flexShrink: 0, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp.md, marginBottom: sp.sm }}>
      <span style={{ color: c.text.secondary, fontSize: 13, width: 44, flexShrink: 0 }}>{label}</span>
      <button onClick={() => onStep(-1)} aria-label={`${label} earlier`} style={btn}><Minus size={18} weight='bold' /></button>
      <span style={{ flex: 1, textAlign: 'center', color: c.text.primary, fontSize: 17, fontFamily: MONO }}>{value}</span>
      <button onClick={() => onStep(1)} aria-label={`${label} later`} style={btn}><Plus size={18} weight='bold' /></button>
    </div>
  )
}

// When to remind, for a single item. `value` is epoch ms or null.
function WhenSheet ({ open, value, onClose, onPick, onClear }) {
  const [exact, setExact] = useState(null) // null = showing presets
  useEffect(() => { if (open) setExact(null) }, [open])
  if (!open) return null
  const now = Date.now()
  const current = describeWhen(value, now)
  const shown = describeWhen(exact, now)
  return (
    <BottomSheet open={open} onClose={onClose} title='Remind me'>
      {exact == null ? (
        <>
          {itemPresets(now).map((p) => {
            const d = describeWhen(p.at, now)
            return <PresetRow key={p.key} label={p.label} detail={`${d.day} ${d.time}`} onClick={() => { onPick(p.at); onClose() }} />
          })}
          <PresetRow label='Pick exact time' onClick={() => setExact(value && value > now ? value : defaultExact(now))} />
          {value ? <PresetRow label='Remove reminder' detail={current ? `${current.day} ${current.time}` : ''} danger onClick={() => { onClear(); onClose() }} /> : null}
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', color: c.text.primary, fontSize: 20, fontWeight: 300, margin: `0 0 ${sp.base}px` }}>
            {shown ? `${shown.day}, ${shown.time}` : ''}
          </div>
          <Stepper label='Day' value={shown ? shown.day : ''} onStep={(n) => setExact((v) => stepDays(v, n))} />
          <Stepper label='Time' value={shown ? shown.time : ''} onStep={(n) => setExact((v) => stepMinutes(v, n))} />
          {exact <= now
            ? <div style={{ color: c.error, fontSize: 12, margin: `${sp.xs}px 0 ${sp.sm}px` }}>That is in the past, so nothing would fire.</div>
            : null}
          <Button disabled={exact <= now} onClick={() => { onPick(exact); onClose() }} style={{ marginTop: sp.sm, opacity: exact <= now ? 0.5 : 1 }}>Set reminder</Button>
          <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={() => setExact(null)}>Back</Button>
        </>
      )}
    </BottomSheet>
  )
}

// Time of day for the daily digest. No date, and no past-time filtering: it
// repeats, so a time earlier than now just means "starting tomorrow".
function TimeOfDaySheet ({ open, hour, minute, onClose, onPick }) {
  const [exact, setExact] = useState(null)
  useEffect(() => { if (open) setExact(null) }, [open])
  if (!open) return null
  // Steppers work in epoch ms, so borrow an arbitrary date and read the clock off it.
  const asMs = (h, m) => new Date(2026, 0, 1, h, m).getTime()
  const label = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <BottomSheet open={open} onClose={onClose} title='Remind me each day at'>
      {exact == null ? (
        <>
          {dailyPresets().map((p) => (
            <PresetRow key={p.key} label={p.label} detail={label(asMs(p.hour, p.minute))}
              onClick={() => { onPick(p.hour, p.minute); onClose() }} />
          ))}
          <PresetRow label='Pick exact time' onClick={() => setExact(asMs(hour ?? 18, minute ?? 0))} />
        </>
      ) : (
        <>
          {/* No summary line here, unlike WhenSheet: there is only one stepper, so
              a heading above it would just be the same value printed twice. */}
          <Stepper label='Time' value={label(exact)} onStep={(n) => setExact((v) => stepMinutes(v, n))} />
          <Button style={{ marginTop: sp.sm }} onClick={() => { const d = new Date(exact); onPick(d.getHours(), d.getMinutes()); onClose() }}>Set time</Button>
          <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={() => setExact(null)}>Back</Button>
        </>
      )}
    </BottomSheet>
  )
}

function Toggle ({ on: isOn, onChange, disabled }) {
  return (
    <button onClick={() => { if (!disabled) onChange(!isOn) }} disabled={disabled} aria-label='toggle' style={{ width: 44, height: 26, flexShrink: 0, borderRadius: r.full, border: 'none', cursor: disabled ? 'default' : 'pointer', background: isOn ? c.primary : c.track, position: 'relative', transition: 'background 160ms', padding: 0, opacity: disabled ? 0.4 : 1 }}>
      <span style={{ position: 'absolute', top: 3, left: isOn ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.35)', transition: 'left 160ms' }} />
    </button>
  )
}

// Assignee initial chip with a stable color from the suite avatar palette.
const AVATAR_COLORS = ['#6C9BF5', '#7FB77E', '#E8A87C', '#C38D9E', '#85CDCA', '#E27D60', '#B388EB', '#F0C987']
function AssigneeChip ({ name }) {
  if (!name) return null
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length]
  return <span title={name} style={{ width: 22, height: 22, borderRadius: '50%', background: bg, color: '#0a1f23', fontSize: 11, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{name.slice(0, 1).toUpperCase()}</span>
}

function Avatar ({ name, avatar, size = 40 }) {
  const src = avatarSrc(avatar)
  if (src) return <img src={src} alt='' style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  return <div style={{ width: size, height: size, borderRadius: '50%', background: c.surface.elevated, color: c.text.secondary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 400, flexShrink: 0 }}>{initialsFor(name)}</div>
}

// Resolve an assignee pubkey to that member's avatar (or a neutral ? if the
// roster hasn't synced them yet).
// Resolve a stored assignee to the person it belongs to. `assignee` is a DEVICE
// key, and a person with two phones is one row covering both - so matching on the
// row's pubkey alone renders their other phone as "?".
function memberFor (members, pubkey) {
  return members.find((x) => x.pubkey === pubkey || (x.keys && x.keys.includes(pubkey)))
}
function AssigneeAvatar ({ pubkey, members, size = 22 }) {
  if (!pubkey) return null
  const m = memberFor(members, pubkey)
  return <Avatar name={m?.displayName || '?'} avatar={m?.avatar} size={size} />
}
function memberLabel (members, pubkey, selfPubkey) {
  if (!pubkey) return 'Nobody'
  const m = memberFor(members, pubkey)
  const base = m?.displayName || 'Unknown'
  // "(You)" must follow the PERSON, not the device: a list assigned to your other
  // phone is still assigned to you.
  const mine = m && (m.pubkey === selfPubkey || (m.keys && m.keys.includes(selfPubkey)))
  return (pubkey === selfPubkey || mine) ? base + ' (You)' : base
}

// Pick a household member (or nobody) to assign an item or list to.
function AssigneePickerSheet ({ open, onClose, members, selfPubkey, current, onPick }) {
  const Row = ({ pubkey, children }) => (
    <button onClick={() => { onPick(pubkey); onClose() }} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }}>
      {children}
      {current === pubkey ? <Check size={18} color={c.primary} weight='bold' /> : null}
    </button>
  )
  return (
    <BottomSheet open={open} onClose={onClose} title='Assign to'>
      <Row pubkey={null}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', border: `1px dashed ${c.text.muted}`, flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>Nobody</span>
      </Row>
      {members.map((m) => (
        <Row key={m.pubkey} pubkey={m.pubkey}>
          <Avatar name={m.displayName} avatar={m.avatar} size={32} />
          <span style={{ flex: 1, textAlign: 'left' }}>{m.pubkey === selfPubkey ? m.displayName + ' (You)' : m.displayName}</span>
        </Row>
      ))}
    </BottomSheet>
  )
}

// Pick a grocery aisle for an item (item detail -> Aisle row). Lists every known
// aisle, so an item can be filed into one that has no items yet - which drag
// cannot reach, since an empty aisle renders no drop target. Writes via the same
// synced ai:setCategory path as the drag.
// Generic group picker: grocery passes the built-in AISLES (noun 'aisle');
// user-defined sections pass no built-ins (noun 'section'). onPick(null) clears
// the item's group ("No aisle" / "No section"). New name creates a custom one.
function AislePickerSheet ({ open, onClose, current, onPick, custom = [], noun = 'aisle', builtins = aisles.AISLES }) {
  const [newName, setNewName] = useState('')
  useEffect(() => { if (open) setNewName('') }, [open])
  const clean = aisles.sanitizeCustomAisle(newName)
  const add = () => { if (clean) { onPick(clean); onClose() } }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }
  // Built-ins + the user's custom groups, sorted alphabetically for quick scanning
  // (case-insensitive), with the 'Other' catch-all pinned last for grocery. (The
  // grouped list keeps canonical shelf order; this is just the picker.)
  const hasFallback = builtins.includes(aisles.FALLBACK)
  const extra = custom.filter((a) => !builtins.includes(a))
  const options = [...builtins.filter((a) => a !== aisles.FALLBACK), ...extra]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .concat(hasFallback ? [aisles.FALLBACK] : [])
  return (
    <BottomSheet open={open} onClose={onClose} title={`Choose ${noun}`}>
      <button onClick={() => { onPick(null); onClose() }} style={{ ...rowStyle, color: c.text.secondary }}>
        <span style={{ flex: 1, textAlign: 'left' }}>No {noun}</span>
        {!current ? <Check size={18} color={c.primary} weight='bold' /> : null}
      </button>
      {options.map((a) => (
        <button key={a} onClick={() => { onPick(a); onClose() }} style={rowStyle}>
          <span style={{ flex: 1, textAlign: 'left' }}>{a}</span>
          {current === a ? <Check size={18} color={c.primary} weight='bold' /> : null}
        </button>
      ))}
      <div style={{ display: 'flex', gap: sp.sm, borderTop: `1px solid ${c.divider}`, paddingTop: sp.md, marginTop: sp.xs }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} placeholder={`New ${noun}`} maxLength={24} autoCapitalize='words'
          style={{ flex: 1, minWidth: 0, padding: '10px 12px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontFamily: FONT, outline: 'none' }} />
        <button onClick={add} disabled={!clean} style={{ padding: '0 16px', borderRadius: r.md, border: 'none', background: clean ? c.primary : c.surface.input, color: clean ? c.text.onPrimary : c.text.muted, cursor: clean ? 'pointer' : 'default', fontSize: 14, fontWeight: 500 }}>Add</button>
      </div>
    </BottomSheet>
  )
}

// Accordion card matching the suite (rotating chevron, max-height body).
function Collapsible ({ title, open, onToggle, children }) {
  return (
    <div style={{ background: c.surface.elevated, borderRadius: r.lg, overflow: 'hidden', marginBottom: sp.sm }}>
      <button onClick={onToggle} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${sp.base}px`, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 400 }}>
        <span>{title}</span>
        <CaretRight size={18} color={c.text.muted} weight='regular' style={{ transition: 'transform 0.3s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }} />
      </button>
      <div style={{ maxHeight: open ? 600 : 0, overflow: 'hidden', transition: 'max-height 0.35s cubic-bezier(0.4,0,0.2,1)' }}>
        <div style={{ padding: `0 ${sp.base}px ${sp.base}px` }}>{children}</div>
      </div>
    </div>
  )
}

// Full-screen slide-up panel with a centered back-bar (primary navigation).
// Inline panel for a bottom-nav section (Settings, About). Header + scrollable
// body; no back button - the bottom TabBar switches sections. Returns a fragment
// so its header + scroll slot in as flex children of the app shell, with the
// TabBar sitting below them.
function FullScreen ({ title, children }) {
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `calc(var(--pear-safe-top) + ${sp.md}px) ${sp.base}px ${sp.md}px`, borderBottom: `1px solid ${c.border}` }}>
        <h1 style={{ fontSize: 20, fontWeight: 400, margin: 0, color: c.text.primary }}>{title}</h1>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: sp.base, maxWidth: 600, width: '100%', margin: '0 auto' }}>{children}</div>
    </>
  )
}

// Bottom navigation, suite-standard (mirrors PearGuard's TabBar): switches the
// top-level sections. Rendered as the shell's last flex child on top-level
// screens; hidden while a list is open (that is a drill-down).
function TabBar ({ active, onChange }) {
  const tabs = [
    { key: 'lists', label: 'Lists', Icon: House },
    { key: 'settings', label: 'Settings', Icon: GearSix },
    { key: 'about', label: 'About', Icon: Info },
  ]
  return (
    <div style={{ display: 'flex', borderTop: `1px solid ${c.border}`, background: c.surface.card, paddingBottom: 'var(--pear-safe-bottom)' }}>
      {tabs.map(({ key, label, Icon }) => {
        const on = active === key
        return (
          <button key={key} onClick={() => { haptic('light'); onChange(key) }} aria-label={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: `${sp.sm}px 0`, border: 'none', background: 'none', cursor: 'pointer' }}>
            <Icon size={22} weight={on ? 'fill' : 'regular'} color={on ? c.primary : c.text.muted} />
            <span style={{ fontSize: 11, fontWeight: on ? 500 : 400, color: on ? c.primary : c.text.muted }}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

// QR of the invite, always on a white quiet-zone box so it scans in dark mode.
function QrImage ({ text, size = 200 }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    QRCode.toString(text || '', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => { if (alive) setUrl('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)) }).catch(() => {})
    return () => { alive = false }
  }, [text])
  return (
    <div style={{ width: size, height: size, background: '#fff', borderRadius: r.md, padding: 8, boxSizing: 'content-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {url ? <img src={url} width={size} height={size} alt='Invite QR code' /> : null}
    </div>
  )
}

// In-WebView QR scanner: camera stream -> canvas frames -> jsQR decode. Works in
// a browser and in a WebView once the shell grants camera permission. (The suite
// uses a native scanner; this keeps scanning working before the shell exists.)
function ScannerView ({ open, onClose, onDecode }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!open) return
    setError(null)
    let stream = null; let raf = null; let cancelled = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const stop = () => { cancelled = true; if (raf) cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()) }
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera not available on this device')
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        const v = videoRef.current
        v.srcObject = stream; await v.play()
        const tick = () => {
          if (cancelled) return
          if (v.readyState >= 2 && v.videoWidth) {
            canvas.width = v.videoWidth; canvas.height = v.videoHeight
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
            let img = null
            try { img = ctx.getImageData(0, 0, canvas.width, canvas.height) } catch {}
            if (img) {
              const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
              if (found?.data) { stop(); onDecode(found.data); return }
            }
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
      } catch (e) { setError(e?.message || 'Could not open the camera') }
    })()
    return stop
  }, [open])
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: '#000' }}>
      <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ width: 240, height: 240, border: `3px solid ${c.primary}`, borderRadius: r.lg }} />
      </div>
      <button onClick={onClose} aria-label='Close scanner' style={{ position: 'absolute', top: sp.base, right: sp.base, width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.5)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={20} weight='regular' /></button>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 14, padding: `${sp.xl}px ${sp.base}px`, background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }}>
        {error || 'Point the camera at an invite QR code'}
      </div>
    </div>
  )
}

// Two-week donation nudge (suite pattern). Shown once; gated off on iOS by the caller.
function DonationReminderModal ({ open, onDonate, onDismiss }) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 110, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp.xl }}>
      <div style={{ background: c.surface.card, borderRadius: r.xl, padding: sp.xl, maxWidth: 360, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>⚡</div>
        <h2 style={{ fontSize: 20, fontWeight: 400, margin: `${sp.sm}px 0`, color: c.text.primary }}>Enjoying PearList?</h2>
        <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.5, margin: `0 0 ${sp.lg}px` }}>PearList is free and open source with no ads, accounts, or subscriptions. If you've received value from it, consider returning value to support development.</p>
        <Button onClick={onDonate}>Donate</Button>
        <Button variant='secondary' onClick={onDismiss} style={{ marginTop: sp.sm }}>Maybe later</Button>
        <button onClick={onDismiss} style={{ marginTop: sp.md, background: 'none', border: 'none', color: c.text.muted, fontSize: 14, cursor: 'pointer' }}>Already donated ✓</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item row: the signature is the felt-tip marker strike that draws across the
// text when checked (in the accent green), like crossing it off a paper list.
// ---------------------------------------------------------------------------

// Swipe an item row left to delete it. `touch-action: pan-y` lets the browser
// keep vertical scrolling while we own the horizontal drag, so no preventDefault
// (and no passive-listener fight) is needed. Past the threshold it slides out
// and calls onDelete; short drags snap back.
function SwipeRow ({ children, onDelete, disabled }) {
  const start = useRef(null)
  const axis = useRef(null)
  const dxRef = useRef(0)
  const wrap = useRef(null)
  const [dx, setDxState] = useState(0)
  const [dragging, setDragging] = useState(false)
  const THRESHOLD = 88
  const setDx = (v) => { dxRef.current = v; setDxState(v) }
  const reset = () => { start.current = null; axis.current = null; setDragging(false); setDx(0) }
  const onStart = (e) => { if (disabled) return; const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; axis.current = null; setDragging(true) }
  const onMove = (e) => {
    if (!start.current) return
    const t = e.touches[0]
    const ddx = t.clientX - start.current.x
    const ddy = t.clientY - start.current.y
    if (axis.current === null && (Math.abs(ddx) > 6 || Math.abs(ddy) > 6)) axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'h' : 'v'
    if (axis.current === 'h') setDx(Math.max(-(window.innerWidth || 400), Math.min(0, ddx)))
  }
  const onEnd = () => {
    setDragging(false)
    if (dxRef.current <= -THRESHOLD) {
      haptic('warn')
      setDx(-(wrap.current?.offsetWidth || 400)) // slide the rest of the way out
      setTimeout(() => onDelete(), 190)
    } else setDx(0)
    start.current = null; axis.current = null
  }
  return (
    <div ref={wrap} style={{ position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden='true' style={{ position: 'absolute', inset: 0, background: c.error, display: disabled ? 'none' : 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 22, color: '#fff' }}><TrashIcon /></div>
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={reset}
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform 200ms cubic-bezier(0.32,0.72,0,1)', background: c.surface.base, touchAction: 'pan-y', position: 'relative', willChange: 'transform' }}>
        {children}
      </div>
    </div>
  )
}

// Three quick pulses over a just-added item to pull the eye to where it landed
// after the list auto-scrolls to it. Overlays the row (pointer-events none) so it
// reads over the opaque row background. Keyed by the caller so it re-mounts and
// replays each time a new item is added.
function ItemFlash ({ on }) {
  if (!on) return null
  return <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none', borderRadius: r.md, background: 'color-mix(in srgb, var(--color-primary) 32%, transparent)', animation: 'pearlist-flash 1.25s ease-in-out forwards' }} />
}

// Transient "Item deleted · Undo" toast, above the composer.
function UndoToast ({ onUndo }) {
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 'calc(var(--pear-safe-bottom) + 84px)', transform: 'translateX(-50%)', zIndex: 130, maxWidth: 560, width: 'calc(100% - 24px)', background: c.surface.elevated, color: c.text.primary, padding: '10px 8px 10px 16px', borderRadius: r.lg, fontSize: 14, display: 'flex', alignItems: 'center', gap: sp.sm, boxShadow: '0 6px 20px rgba(0,0,0,0.45)', border: `1px solid ${c.border}` }}>
      <span style={{ flex: 1 }}>Item deleted</span>
      <button onClick={onUndo} style={{ background: 'none', border: 'none', color: c.primary, fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: '4px 14px' }}>Undo</button>
    </div>
  )
}

function ItemRow ({ item, members, onToggle, onOpen, dragHandle }) {
  const checked = !!item.checked
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.base}px`, borderBottom: `1px solid ${c.divider}` }}>
      <button onClick={() => onToggle(item)} data-haptic={checked ? 'light' : 'success'} aria-label={checked ? 'uncheck' : 'check'} style={{ width: 24, height: 24, flexShrink: 0, borderRadius: '50%', border: `2px solid ${checked ? c.primary : c.text.muted}`, background: checked ? c.primary : 'transparent', color: c.text.onPrimary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, padding: 0, animation: checked ? 'pearlist-pop 240ms ease' : 'none' }}>{checked ? <Check size={15} weight='bold' /> : null}</button>
      <button onClick={() => onOpen(item)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: sp.sm, maxWidth: '100%' }}>
          <span style={{ position: 'relative', color: checked ? c.text.muted : c.text.primary, fontSize: 16, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.text}
            <span style={{ position: 'absolute', left: 0, right: 0, top: '52%', height: 2, background: c.primary, borderRadius: 2, transformOrigin: 'left', transform: checked ? 'scaleX(1)' : 'scaleX(0)', transition: 'transform 220ms cubic-bezier(0.32,0.72,0,1)' }} />
          </span>
          {item.qty > 1 ? <span style={{ fontFamily: MONO, fontSize: 12, color: c.text.secondary, background: c.surface.elevated, borderRadius: r.sm, padding: '1px 6px', flexShrink: 0 }}>×{item.qty}</span> : null}
        </span>
        {item.note ? <span style={{ color: c.text.muted, fontSize: 13, fontWeight: 300, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{item.note}</span> : null}
      </button>
      {item.url ? <button onClick={(e) => { e.stopPropagation(); openUrl(item.url) }} aria-label='Open link' style={{ width: 34, height: 34, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: c.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LinkIcon /></button> : null}
      <AssigneeAvatar pubkey={item.assignee} members={members} size={24} />
      {dragHandle ? <span
        onTouchStart={(e) => { e.stopPropagation(); dragHandle.onTouchStart?.(e) }}
        onPointerDown={(e) => { e.stopPropagation(); dragHandle.onPointerDown?.(e) }}
        onClick={(e) => e.stopPropagation()} aria-label='Reorder'
        style={{ flexShrink: 0, marginLeft: 2, padding: '6px 2px', color: c.text.muted, cursor: 'grab', touchAction: 'none', display: 'flex', alignItems: 'center' }}><DotsSixVertical size={20} weight='bold' /></span> : null}
    </div>
  )
}

// Where the user was: the space and, if any, the list they had open. Device-local
// and purely navigational.
//
// This matters more than it looks. The GrapheneOS/Vanadium freeze recovery
// (modules/webview-recovery) reloads the WebView on any resume after ~20s
// backgrounded, and a reload resets all in-memory UI state - so without this,
// glancing away mid-shop and coming back drops you at the lists overview, in
// whichever space happens to be first. Restoring is always best-effort: a saved
// id that no longer resolves (space left, list deleted) is simply ignored.
const PLACE_KEY = 'pearlist:place'
function loadPlace () { try { return JSON.parse(localStorage.getItem(PLACE_KEY) || '{}') || {} } catch { return {} } }
function savePlace (patch) { try { localStorage.setItem(PLACE_KEY, JSON.stringify({ ...loadPlace(), ...patch })) } catch {} }
// Snapshotted at load, which is exactly once per WebView load, so the restore
// reads where we WERE. Reading it inside the component instead would race the
// writer effect below, whose first run (openListId still null) would wipe the
// saved list a moment before we tried to restore it.
const BOOT_PLACE = loadPlace()

// Device-local view preferences for a grocery list (collapsed aisles + custom
// order), stored in localStorage keyed by list id. Purely presentational, never
// synced (see 2026-07-11 hybrid decision: reorder/collapse are per-device).
const aisleViewKey = (listId) => `pearlist:aisleview:${listId}`
function loadAisleView (listId) { try { return JSON.parse(localStorage.getItem(aisleViewKey(listId)) || '{}') || {} } catch { return {} } }
function saveAisleView (listId, patch) { try { const v = { ...loadAisleView(listId), ...patch }; localStorage.setItem(aisleViewKey(listId), JSON.stringify(v)); return v } catch { return patch } }

// Device-local preference: close a group once every item in it is checked off
// (GH #90). Off by default, so an update never changes how anyone's list behaves
// until they ask for it. One switch for every list, not per list.
const AUTOCOLLAPSE_KEY = 'pearlist:autocollapse'
function loadAutoCollapse () { try { return localStorage.getItem(AUTOCOLLAPSE_KEY) === '1' } catch { return false } }
function saveAutoCollapse (on) { try { localStorage.setItem(AUTOCOLLAPSE_KEY, on ? '1' : '0') } catch {} }

// User-made aisle names remembered per space (device-local), so a custom aisle
// stays offered in the picker even after its last item leaves it (an empty aisle
// renders nothing). Purely a convenience list; the aisle itself lives on items.
const customAislesKey = (spaceId) => `pearlist:customaisles:${spaceId}`
function loadCustomAisles (spaceId) { try { return spaceId ? (JSON.parse(localStorage.getItem(customAislesKey(spaceId)) || '[]') || []) : [] } catch { return [] } }
function rememberCustomAisle (spaceId, name) { try { if (!spaceId || !name) return; const cur = loadCustomAisles(spaceId); if (!cur.includes(name)) localStorage.setItem(customAislesKey(spaceId), JSON.stringify([...cur, name].slice(-50))) } catch {} }

// Learn from manual aisle corrections: a device-local item-text -> aisle memory.
// When the user drags an item to another aisle or picks one by hand, remember it;
// next time an item with the same text is added it is pre-filed there (pinned,
// by:'user'), ahead of the keyword/LLM classifier. Device-local only (a personal
// shopping habit, not a household rule) - a synced version is a later option.
// Capped, most-recent-wins.
const OVERRIDES_KEY = 'pearlist:aisleOverrides'
const normItemText = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ')
function loadOverrides () { try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') || {} } catch { return {} } }
function rememberOverride (text, aisle) {
  try {
    const n = normItemText(text); if (!n || !aisle) return
    const m = loadOverrides(); if (m[n] === aisle) return
    delete m[n]; m[n] = aisle // re-insert so it counts as most-recently-used
    const keys = Object.keys(m); if (keys.length > 500) delete m[keys[0]]
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(m))
  } catch {}
}
// Restore learned aisles from a backup. MERGE, and this device wins: an entry it
// already holds is a correction the user made HERE, which is newer information
// than a file that has been sitting in Downloads. Same 500 cap as rememberOverride,
// oldest dropped first, so a big file cannot push out everything recent.
function mergeOverrides (incoming) {
  try {
    if (!incoming || typeof incoming !== 'object') return 0
    const m = loadOverrides()
    let added = 0
    for (const [text, aisle] of Object.entries(incoming)) {
      const n = normItemText(text)
      if (!n || !aisle || m[n]) continue
      m[n] = String(aisle)
      added++
    }
    const keys = Object.keys(m)
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete m[k]
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(m))
    return added
  } catch { return 0 }
}
function overrideFor (text) { try { return loadOverrides()[normItemText(text)] || null } catch { return null } }
function overrideCount () { try { return Object.keys(loadOverrides()).length } catch { return 0 } }
function clearOverrides () { try { localStorage.removeItem(OVERRIDES_KEY) } catch {} }

// Imperative confirm backed by a themed bottom sheet (ConfirmHost registers the
// handler on mount), replacing the native window.confirm ("JavaScript" title).
// Falls open to true if no host is mounted.
let _askConfirm = null
function askConfirm (opts) { return _askConfirm ? _askConfirm(opts) : Promise.resolve(true) }

// Single themed confirm dialog for the whole app (see askConfirm). Rendered once.
function ConfirmHost () {
  const [state, setState] = useState(null)
  useEffect(() => { _askConfirm = (opts) => new Promise((resolve) => setState({ ...opts, resolve })); return () => { _askConfirm = null } }, [])
  const done = (v) => { const s = state; setState(null); s?.resolve(v) }
  return (
    <BottomSheet open={!!state} onClose={() => done(false)} title={state?.title}>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.5, margin: `0 0 ${sp.base}px` }}>{state?.message}</p>
      {/* Equal-width buttons: the confirm and Cancel carry the same weight, so one
          does not read as the obvious choice by size alone. Applies to every
          askConfirm (Remove, Stronger removal, Leave, Clear learned aisles...). */}
      <div style={{ display: 'flex', gap: sp.sm }}>
        <button onClick={() => done(true)} style={{ flex: 1, padding: '11px 14px', borderRadius: r.md, border: 'none', background: state?.danger ? c.error : c.primary, color: state?.danger ? '#000' : c.text.onPrimary, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>{state?.confirmLabel || 'Confirm'}</button>
        {/* `noCancel` makes this an acknowledgement rather than a choice. Offering
            "Cancel" on a notice invites the question "cancel what?" about
            something that has already happened. */}
        {state?.noCancel ? null : <button onClick={() => done(false)} style={{ flex: 1, padding: '11px 14px', borderRadius: r.md, border: `1px solid ${c.text.muted}`, background: 'transparent', color: c.text.secondary, fontSize: 14, cursor: 'pointer' }}>Cancel</button>}
      </div>
    </BottomSheet>
  )
}

// Long-press drag controller for the grouped grocery view. Coexists with the
// row swipe-to-delete: a horizontal move before the hold-timer cancels the drag
// (so swipe still works); holding still ~320ms activates a drag. Items reorder
// within their aisle or drop into another aisle to re-file (recategorize);
// headers reorder aisles. All device-local. Returns handlers + live drag state +
// a floating ghost to render. Pointer events (works in the WebView on touch).
const HOLD_MS = 130 // short: drags start from an explicit grip handle (touch-action:none),
const HOLD_TOL = 10 // px of finger movement allowed during the hold; within this we
// block the browser's native scroll so the long-press can complete (fixes the
// "scroll steals the gesture" conflict). Move past it and it's treated as a
// scroll/swipe and released. Elevation (lift look) is driven by React via the
// `lifted` state; the hook only ever sets `transform`/`pointerEvents` imperatively
// (never React-managed props like background), so it can't wipe a header's colour.
function useAisleDrag ({ items, aisleView, scrollRef, builtins, onReorderItems, onReorderAisles, onRecategorize }) {
  const [dragOver, setDragOver] = useState(null) // { kind, aisle } - cross-aisle / header target highlight
  const [lifted, setLifted] = useState(null)     // { kind, id } - the elevated element (React renders the lift)
  // dragProps is useCallback([]) (stable handlers), which freezes begin/commit -
  // and the callbacks they close over - at first-render values (when no list was
  // open: gid=false, openListId=null). Keep the live items/view AND callbacks in
  // this per-render ref so the frozen commit always calls the CURRENT handlers.
  // Without this, cross-aisle recategorize silently no-ops (stale gid/openListId).
  const data = useRef({})
  data.current = { items, aisleView, builtins, onReorderItems, onReorderAisles, onRecategorize }
  const S = useRef({})
  const justDragged = useRef(false)

  const clearImperative = () => {
    const s = S.current
    if (s.el) { s.el.style.transform = ''; s.el.style.transition = ''; s.el.style.pointerEvents = '' }
    ;(s.rows || []).forEach((row) => { if (row.el !== s.el) { row.el.style.transform = ''; row.el.style.transition = '' } })
  }
  const cleanup = () => {
    const s = S.current
    window.removeEventListener('touchmove', s.onTouchMove, { passive: false })
    window.removeEventListener('touchend', s.onEnd)
    window.removeEventListener('touchcancel', s.onEnd)
    window.removeEventListener('pointermove', s.onPointerMove)
    window.removeEventListener('pointerup', s.onEnd)
    if (s.timer) clearTimeout(s.timer)
    if (s.raf) cancelAnimationFrame(s.raf)
    clearImperative()
    S.current = {}
    setLifted(null); setDragOver(null)
  }

  const scrollDelta = (s) => (scrollRef?.current ? scrollRef.current.scrollTop - (s.scroll0 || 0) : 0)

  // Which aisle section is under a viewport y? Uses each [data-aisle] container's
  // LAYOUT rect rather than elementFromPoint. Reorder shifts sibling rows with
  // transforms (visual only, they don't reflow the container), and elementFromPoint
  // hit-tests those shifted rows - so near an aisle boundary it can report the
  // wrong section and flip-flop the target frame to frame. Layout rects don't move
  // under child transforms, so the boundary is stable. Header-height rect covers a
  // collapsed aisle too, so an item can be re-filed into one.
  const aisleAtPoint = (y) => {
    const root = scrollRef?.current || document
    for (const node of root.querySelectorAll('[data-aisle]')) {
      const rc = node.getBoundingClientRect()
      if (y >= rc.top && y <= rc.bottom) return node.getAttribute('data-aisle')
    }
    return null
  }

  const autoscroll = () => {
    const s = S.current
    const el = scrollRef?.current
    if (s.active && el) {
      const rc = el.getBoundingClientRect()
      let d = 0
      if (s.y < rc.top + 78) d = -10
      else if (s.y > rc.bottom - 100) d = 10
      if (d) { el.scrollTop += d; positionDrag() } // keep lift + gap synced while auto-scrolling
    }
    if (s.active) s.raf = requestAnimationFrame(autoscroll)
  }

  // Follow the finger + open the slot (items) or highlight the target (aisles).
  const positionDrag = () => {
    const s = S.current
    if (!s.active) return
    const sd = scrollDelta(s)
    const el = document.elementFromPoint(s.x, s.y) // s.el has pointer-events:none, so this sees beneath it
    if (s.kind === 'item') {
      s.el.style.transform = `translateY(${s.y - s.startY + sd}px) scale(1.02)`
      const overAisle = aisleAtPoint(s.y)
      if (overAisle && overAisle !== s.aisle) {
        s.targetAisle = overAisle
        s.rows.forEach((row) => { if (row.el !== s.el) row.el.style.transform = 'translateY(0px)' })
        setDragOver((d) => (d && d.aisle === overAisle) ? d : { kind: 'item', aisle: overAisle })
      } else {
        s.targetAisle = null
        setDragOver((d) => d ? null : d)
        const others = s.rows.filter((row) => row.id !== s.id)
        let insertAt = 0
        for (const row of others) { if (row.center - sd < s.y) insertAt++ }
        s.newIndex = insertAt
        for (let j = 0; j < others.length; j++) {
          const row = others[j]
          const finalJ = j < insertAt ? j : j + 1
          row.el.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)'
          row.el.style.transform = `translateY(${(finalJ - s.rows.indexOf(row)) * s.rowH}px)`
        }
      }
    } else {
      s.el.style.transform = `translateY(${s.y - s.startY + sd}px)`
      const overHeader = el?.closest('[data-aisle-header]')?.getAttribute('data-aisle-header')
      if (overHeader) { s.targetAisle = overHeader; setDragOver((d) => (d && d.aisle === overHeader) ? d : { kind: 'aisle', aisle: overHeader }) }
    }
  }

  const activate = () => {
    const s = S.current
    if (!s.id) return
    s.active = true
    try { haptic('medium') } catch {}
    s.scroll0 = scrollRef?.current ? scrollRef.current.scrollTop : 0
    if (s.kind === 'item') {
      const container = s.el.closest('[data-aisle]')
      const els = container ? [...container.querySelectorAll(':scope [data-item-id]')] : [s.el]
      s.rows = els.map((el) => { const rc = el.getBoundingClientRect(); return { el, id: el.getAttribute('data-item-id'), center: rc.top + rc.height / 2, h: rc.height } })
      s.originIndex = s.rows.findIndex((row) => row.id === s.id)
      s.rowH = (s.rows[s.originIndex] && s.rows[s.originIndex].h) || 48
      s.newIndex = s.originIndex
    }
    s.el.style.pointerEvents = 'none' // imperative (not React-managed) so hit-testing sees beneath
    s.el.style.transition = 'transform 120ms ease'
    setLifted({ kind: s.kind, id: s.id }) // React applies the elevated look
    positionDrag()
    s.raf = requestAnimationFrame(autoscroll)
  }

  const onMoveCommon = (x, y, preventDefault) => {
    const s = S.current
    if (!s.id) return
    s.x = x; s.y = y
    if (!s.active) {
      if (Math.hypot(x - s.startX, y - s.startY) <= HOLD_TOL) { preventDefault && preventDefault() } // hold: block scroll
      else cleanup() // moved out -> it's a scroll/swipe; release the gesture
      return
    }
    preventDefault && preventDefault()
    positionDrag()
  }

  const commit = (s) => {
    const { items: its, aisleView: av, builtins: bi, onReorderItems, onReorderAisles, onRecategorize } = data.current
    if (s.kind === 'aisle') {
      const present = [...new Set(its.map((it) => aisles.bucketOf(it.category)))]
      const ord = orderAisles(present, av.aisleOrder, bi).filter((a) => a !== s.id)
      const at = s.targetAisle && s.targetAisle !== s.id ? ord.indexOf(s.targetAisle) : ord.length
      ord.splice(at < 0 ? ord.length : at, 0, s.id)
      onReorderAisles(ord)
      return
    }
    if (s.targetAisle && s.targetAisle !== s.aisle) { onRecategorize(s.id, s.targetAisle); return }
    const buckets = new Map()
    for (const it of its) { const k = aisles.bucketOf(it.category); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(it) }
    const aisleIds = orderRows(buckets.get(s.aisle) || [], av.itemOrder).map((it) => it.id).filter((id) => id !== s.id)
    aisleIds.splice(Math.max(0, Math.min(s.newIndex ?? aisleIds.length, aisleIds.length)), 0, s.id)
    const flat = orderAisles([...buckets.keys()], av.aisleOrder, bi).flatMap((a) => a === s.aisle ? aisleIds : orderRows(buckets.get(a), av.itemOrder).map((it) => it.id))
    onReorderItems(flat)
  }

  const begin = (kind, id, aisle, el, x, y, source) => {
    const s = S.current = { kind, id, aisle, el, startX: x, startY: y, x, y, active: false }
    s.onEnd = () => {
      if (s.active) { commit(s); justDragged.current = true; setTimeout(() => { justDragged.current = false }, 350) }
      cleanup()
    }
    if (source === 'touch') {
      s.onTouchMove = (ev) => { const t = ev.touches[0]; if (t) onMoveCommon(t.clientX, t.clientY, () => { try { ev.preventDefault() } catch {} }) }
      window.addEventListener('touchmove', s.onTouchMove, { passive: false })
      window.addEventListener('touchend', s.onEnd)
      window.addEventListener('touchcancel', s.onEnd)
    } else {
      s.onPointerMove = (ev) => onMoveCommon(ev.clientX, ev.clientY, null)
      window.addEventListener('pointermove', s.onPointerMove)
      window.addEventListener('pointerup', s.onEnd)
    }
    s.timer = setTimeout(activate, HOLD_MS)
  }

  // The grip handle is inside the row/header; climb to the actual element to lift.
  const dragEl = (handle, kind) => handle.closest(kind === 'item' ? '[data-item-id]' : '[data-aisle-header]') || handle
  const dragProps = useCallback((kind, id, aisle) => ({
    onTouchStart: (e) => { const t = e.touches[0]; if (t) begin(kind, id, aisle, dragEl(e.currentTarget, kind), t.clientX, t.clientY, 'touch') },
    onPointerDown: (e) => { if (e.pointerType === 'touch') return; if (e.button != null && e.button !== 0) return; begin(kind, id, aisle, dragEl(e.currentTarget, kind), e.clientX, e.clientY, 'mouse') },
  }), [])

  return { dragProps, dragOver, lifted, didDrag: () => justDragged.current }
}

// Order the present groups: any in the device-local order first (that sequence),
// then the remaining built-ins in canonical order, then custom (user-made) groups
// alphabetically, and the fallback ('Other'/'Ungrouped') always last. `builtins`
// is the fixed taxonomy (grocery aisles); for user-defined sections it is empty,
// so every group is "custom".
function orderAisles (present, aisleOrder, builtins = aisles.AISLES) {
  const set = new Set(present)
  const first = (aisleOrder || []).filter((a) => set.has(a))
  const used = new Set(first)
  const builtin = builtins.filter((a) => a !== aisles.FALLBACK && set.has(a) && !used.has(a))
  const custom = present.filter((a) => !builtins.includes(a) && a !== aisles.FALLBACK && !used.has(a)).sort()
  const other = (set.has(aisles.FALLBACK) && !used.has(aisles.FALLBACK)) ? [aisles.FALLBACK] : []
  return [...first, ...builtin, ...custom, ...other]
}
// Order items within an aisle: those in `itemOrder` first (that sequence), then
// the rest by createdAt (stable original order).
function orderRows (rows, itemOrder) {
  const idx = new Map((itemOrder || []).map((id, i) => [id, i]))
  return rows.slice().sort((a, b) => {
    const ia = idx.has(a.id) ? idx.get(a.id) : Infinity
    const ib = idx.has(b.id) ? idx.get(b.id) : Infinity
    if (ia !== ib) return ia - ib
    return (a.createdAt || 0) - (b.createdAt || 0)
  })
}

// Grocery lists render items grouped under aisle headers in device-local order.
// Headers collapse/expand (tap) and show an open/total count. Long-press an item
// or a header to drag: items reorder within their aisle, or drop into another
// aisle to re-file them there; headers reorder the aisles. All order is
// per-device (see the 2026-07-11 hybrid decision). `dragProps(kind,id,aisle)`
// wires the long-press handlers from the parent's drag controller.
// Smoothly grows/shrinks an aisle's rows on collapse toggle using the
// grid-template-rows 0fr<->1fr trick (animates auto height with no fixed cap).
// Overflow is clipped while collapsed or mid-animation, but set back to visible
// once fully expanded and idle - otherwise it would clip a cross-aisle drag lift
// (the lifted row translates outside the aisle box). Rows stay mounted while
// collapsed (just clipped to 0), so drag + the just-added scroll can still find
// them.
function CollapsibleRows ({ collapsed, children }) {
  const [clip, setClip] = useState(collapsed)
  useEffect(() => { if (collapsed) setClip(true) }, [collapsed]) // clip immediately when collapsing
  return (
    <div style={{ display: 'grid', gridTemplateRows: collapsed ? '0fr' : '1fr', transition: 'grid-template-rows 340ms cubic-bezier(0.4,0,0.2,1)' }}
      onTransitionEnd={(e) => { if (e.propertyName === 'grid-template-rows' && !collapsed) setClip(false) }}>
      <div style={{ overflow: clip ? 'hidden' : 'visible', minHeight: 0 }}>{children}</div>
    </div>
  )
}

function AisleGroupedItems ({ items, renderRow, collapsed, onToggle, aisleOrder, itemOrder, dragProps, dragOver, lifted, didDrag, flashId, builtins = aisles.AISLES, fallbackLabel = aisles.FALLBACK }) {
  const buckets = new Map()
  for (const it of items) {
    // Keyword classification is synchronous, so an item's aisle is known the
    // moment it is added. Nothing is ever mid-flight, which is why there is no
    // longer a transient "Sorting…" group here.
    const key = aisles.bucketOf(it.category)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(it)
  }
  const sections = orderAisles([...buckets.keys()], aisleOrder, builtins).map((a) => ({ aisle: a, items: orderRows(buckets.get(a), itemOrder) }))
  return (
    <>
      {sections.map(({ aisle, items: rows }) => {
        const isCollapsed = !!collapsed?.has(aisle)
        const open = rows.filter((it) => !it.checked).length
        const aisleTarget = dragOver?.aisle === aisle && dragOver?.kind === 'item'
        const headerLifted = lifted?.kind === 'aisle' && lifted.id === aisle
        const label = aisle === aisles.FALLBACK ? fallbackLabel : aisle
        return (
          <div key={aisle} data-aisle={aisle} style={aisleTarget ? { background: 'color-mix(in srgb, var(--color-primary) 9%, transparent)' } : undefined}>
            <div
              data-aisle-header={aisle}
              style={{ top: 0, width: '100%', display: 'flex', alignItems: 'center', gap: sp.sm, background: aisleTarget ? 'color-mix(in srgb, var(--color-primary) 22%, transparent)' : (dragOver?.kind === 'aisle' && dragOver?.aisle === aisle ? c.surface.input : c.surface.elevated), borderTop: `1px solid ${aisleTarget ? c.primary : c.divider}`, borderBottom: `1px solid ${aisleTarget ? c.primary : c.divider}`, padding: `${sp.sm}px ${sp.base}px`, position: headerLifted ? 'relative' : 'sticky', zIndex: headerLifted ? 50 : 1, boxShadow: headerLifted ? '0 10px 26px rgba(0,0,0,0.45)' : 'none' }}
            >
              <button onClick={() => { if (didDrag?.()) return; onToggle?.(aisle) }} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: sp.sm, background: 'none', border: 'none', padding: 0, cursor: 'pointer', minWidth: 0 }}>
                <CaretRight size={12} weight='bold' color={c.text.muted} style={{ flexShrink: 0, transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform 180ms ease' }} />
                <span style={{ flex: 1, textAlign: 'left', fontSize: 12, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              </button>
              {aisleTarget
                ? <span style={{ fontSize: 12, fontWeight: 600, color: c.primary, flexShrink: 0, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Move to {label}</span>
                : <span style={{ fontFamily: MONO, fontSize: 11, color: c.text.secondary, background: c.surface.input, borderRadius: r.sm, padding: '1px 7px', flexShrink: 0 }}>{open < rows.length ? `${open}/${rows.length}` : rows.length}</span>}
              {dragProps ? <span {...dragProps('aisle', aisle, aisle)} onClick={(e) => e.stopPropagation()} aria-label='Reorder aisle' style={{ flexShrink: 0, padding: '4px 2px', color: c.text.muted, cursor: 'grab', touchAction: 'none', display: 'flex' }}><DotsSixVertical size={18} weight='bold' /></span> : null}
            </div>
            <CollapsibleRows collapsed={isCollapsed}>
              {rows.map((it) => {
                const itemLifted = lifted?.kind === 'item' && lifted.id === it.id
                return (
                  <div key={it.id} data-item-id={it.id}
                    style={itemLifted ? { position: 'relative', zIndex: 50, background: c.surface.elevated, boxShadow: '0 10px 26px rgba(0,0,0,0.45)', borderRadius: r.md, overflow: 'hidden' } : { position: 'relative' }}>
                    {renderRow(it, dragProps ? dragProps('item', it.id, aisle) : undefined, itemLifted)}
                    <ItemFlash on={flashId === it.id} />
                  </div>
                )
              })}
            </CollapsibleRows>
          </div>
        )
      })}
    </>
  )
}

// Three doors, not two, and they are peers on purpose. Restoring is not an
// advanced case: a replacement phone is one of the ordinary ways to arrive here,
// and it is the ONLY one of the three that needs no other device and no network -
// joining needs the other person's phone awake and connected at that moment.
//
// It also has to live here rather than in Settings, because during onboarding
// there IS no Settings: this screen returns before the tab bar renders. Without
// this button a backup file cannot be opened on a phone with no spaces, which is
// most of the point of having one. (Tim, 2026-07-28.)
// FOURTH DOOR, added 2026-07-29 and gated. Before it, a replacement or second
// phone had to Create a space or Join with an invite FIRST - i.e. become a
// separate person - and only then could it reach Settings to link. That made the
// feature close to undiscoverable and taught the wrong thing on the way: the
// device ends up with an identity it did not want.
//
// It renders only when device-link is switched on (device:status.enabled), so an
// ordinary build shows the same three doors it always did. When the flag is off
// the whole feature is dark, and a fourth button leading nowhere would be worse
// than no button.
//
// Wording avoids "link" as the first word because "Link" reads as "paste a URL"
// on a screen where the other three options are about spaces. What the user is
// actually doing is bringing their existing account onto this phone.
function Onboarding ({ onStart, onJoin, onRestore, onLink }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: sp.xl, gap: sp.base, maxWidth: 460, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: sp.lg }}>
        <img src={APP_ICON} alt='' width={64} height={64} style={{ marginBottom: sp.sm, borderRadius: r.xl }} />
        <h1 style={{ fontSize: 28, fontWeight: 400, margin: 0, color: c.text.primary }}>PearList</h1>
        <p style={{ color: c.text.secondary, fontSize: 15, fontWeight: 300, marginTop: sp.sm }}>Shared lists, one private space per group. No account, no server.</p>
      </div>
      <Button variant='primary' onClick={onStart}>Create a space</Button>
      <Button variant='secondary' onClick={onJoin}>Join with an invite</Button>
      <Button variant='secondary' onClick={onRestore}>Open a saved copy</Button>
      {onLink ? <Button variant='secondary' onClick={onLink}>I already use PearList on another phone</Button> : null}
      {isMock ? <p style={{ textAlign: 'center', color: c.text.muted, fontSize: 12, marginTop: sp.base }}>preview mode (no peer sync)</p> : null}
    </div>
  )
}

// First-run: set a display name (required) + optional photo before create/join,
// so peers can resolve who's who instead of a bare "Member".
//
// EXCEPT when you are linking an existing phone, which is what `onLink` is for.
// Naming yourself here is redundant then - your name is about to arrive from the
// other phone - and worse, it was BLOCKING: this screen gates the four doors, so a
// phone could not reach "I already use PearList on another phone" without first
// inventing a name, and that typed name then counted as a deliberate choice the
// linked profile was not allowed to overwrite. Which made the fresh-install case,
// the common one, come out wrong. Found on hardware 2026-07-29.
function NameSetup ({ profile, onDone, onLink }) {
  const fileRef = useRef(null)
  const [name, setName] = useState(profile?.displayName || '')
  const [avatar, setAvatar] = useState(profile?.avatar || null)
  const [busy, setBusy] = useState(false)

  async function onPickFile (e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    const animated = file.type === 'image/gif' || file.type === 'image/webp'
    try {
      if (animated) {
        if (file.size > AVATAR_MAX_BYTES) { alert(`That image is too large. Keep it under ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} MB.`); return }
        setAvatar(await readFileDataUrl(file))
      } else {
        setAvatar(await compressToAvatar(await readFileDataUrl(file)))
      }
    } catch { alert('Could not read that image.') }
  }
  async function cont () {
    const n = name.trim(); if (!n) return
    setBusy(true)
    try { await call('profile:set', { displayName: n, avatar: avatar || undefined }); onDone() }
    catch (e) { alert(problem('Could not save', e)); setBusy(false) }
  }
  const hasAvatar = !!avatarSrc(avatar)
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: sp.xl, gap: sp.base, maxWidth: 460, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: sp.md }}>
        <img src={APP_ICON} alt='' width={64} height={64} style={{ marginBottom: sp.sm, borderRadius: r.xl }} />
        <h1 style={{ fontSize: 26, fontWeight: 400, margin: 0, color: c.text.primary }}>Welcome to PearList</h1>
        <p style={{ color: c.text.secondary, fontSize: 15, fontWeight: 300, marginTop: sp.sm }}>Set your name so the people you share with know who's who.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: sp.sm }}>
        <button onClick={() => fileRef.current?.click()} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, borderRadius: '50%' }}>
          <Avatar name={name} avatar={avatar} size={96} />
        </button>
        <button onClick={() => fileRef.current?.click()} style={{ background: 'none', border: 'none', color: c.primary, fontSize: 14, cursor: 'pointer' }}>{hasAvatar ? 'Change photo' : 'Add a photo (optional)'}</button>
        <input ref={fileRef} type='file' accept='image/*' style={{ display: 'none' }} onChange={onPickFile} />
      </div>
      <input value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') cont() }} placeholder='Your name'
        style={{ padding: '14px 16px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none', textAlign: 'center' }} />
      <Button variant='primary' disabled={busy || !name.trim()} style={{ opacity: busy || !name.trim() ? 0.6 : 1 }} onClick={cont}>Continue</Button>
      {/* Deliberately quieter than Continue: naming yourself is still the normal
          path, and this is the one case where it is the wrong question. */}
      {onLink
        ? <button onClick={onLink} style={{ background: 'none', border: 'none', color: c.text.secondary, fontSize: 14, cursor: 'pointer', padding: sp.sm, textDecoration: 'underline' }}>
            I already use PearList on another phone
          </button>
        : null}
    </div>
  )
}

// A brief once-only tour. On a first run it comes BEFORE the space exists (it is
// what explains what a space even is), so its last step is the create/join
// hand-off; onCreate/onJoin are passed only on that path. Returning users (a
// TOUR_KEY bump) and Settings → Replay get the same steps minus that hand-off,
// since they already have a space.
// Bump TOUR_KEY when the steps change materially so returning users see the new
// ones.
const TOUR_KEY = 'pearlist:tourSeen:v3' // v3: dropped the on-device AI step
const TOUR_STEPS = [
  { Icon: ListBullets, title: 'Lists live in a space', body: 'A space is a private place shared with your household. Every list in it, from Shopping to Chores to To-do, is shared with the people you invite.' },
  { Icon: CheckCircle, title: 'Tap a list to fill it', body: 'Open a list to add items, check them off, set quantities and assign an item to someone. Add a new list with the field at the bottom.' },
  { Icon: ShoppingCart, title: 'Shopping sorts itself', body: 'Items on a Shopping list land in supermarket aisles on their own. Drag one onto another aisle to re-file it and PearList remembers. Other lists can have sections you name yourself.' },
  { Icon: BellRinging, title: 'Know when things get done', body: 'PearList alerts you when someone assigns you an item, joins your space or checks items off a list you created. Every list has its own alert setting in its options menu.' },
  { Icon: ShareNetwork, title: 'Invite your people', body: 'Tap the share icon to invite others. Everyone syncs peer-to-peer, with no account and no server.' },
]
function GuidedTour ({ open, onDone, onCreate, onJoin, onRestore }) {
  const [i, setI] = useState(0)
  useEffect(() => { if (open) setI(0) }, [open])
  if (!open) return null
  // Background-sync expectations, tailored to the platform: iOS pauses background
  // apps (so an all-iPhone space only syncs when open), while Android can keep
  // syncing in the background.
  const bgStep = isIOS()
    ? { Icon: DeviceMobile, title: 'A note for iPhone', body: "iOS pauses apps in the background, so on iPhone PearList syncs and sends alerts mainly while it's open. If everyone in a space is on iPhone, updates only sync when someone has PearList open. Keep an Android device in the space for always-on background sync." }
    : { Icon: ArrowsClockwise, title: 'Syncing in the background', body: "On Android, PearList can keep syncing even when it's closed (Settings → Background Sync), so updates arrive right away, and it keeps iPhone members in your space synced too." }
  // First run only: the tour ends by handing off to create/join, so the space is
  // made with the tour's context behind it rather than before any of it.
  const handoff = onCreate && onJoin
  // The handoff offers the SAME three doors as the screen behind it. A tour that
  // ends on two of them quietly narrows the choice: someone who sat through it is
  // the least likely to go hunting for a third option they were never shown, and
  // the one arriving with a backup file is usually the one replacing a dead phone.
  const spaceStep = { Icon: UsersThree, title: 'Create or join a space', body: 'Start a space for your household, or join one with an invite someone sent you. You can be in more than one, so a family space and a roommate space can live side by side. Replacing a phone? Open a copy you saved from the old one.' }
  const steps = [...TOUR_STEPS, bgStep, ...(handoff ? [spaceStep] : [])]
  const step = steps[i]
  const last = i === steps.length - 1
  const onSpaceStep = handoff && last
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 105, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp.xl }}>
      <div style={{ background: c.surface.card, borderRadius: r.xl, padding: sp.xl, maxWidth: 360, width: '100%', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, margin: '0 auto', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: c.surface.elevated, color: c.primary }}>
          <step.Icon size={30} weight='regular' />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 400, margin: `${sp.base}px 0 ${sp.sm}px`, color: c.text.primary }}>{step.title}</h2>
        <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.5, margin: `0 0 ${sp.lg}px`, minHeight: 105 }}>{step.body}</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: sp.base }}>
          {steps.map((_, k) => <span key={k} style={{ width: 7, height: 7, borderRadius: '50%', background: k === i ? c.primary : c.border }} />)}
        </div>
        {onSpaceStep ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: sp.sm }}>
            <Button variant='primary' onClick={onCreate}>Create a space</Button>
            <Button variant='secondary' onClick={onJoin}>Join with an invite</Button>
            {onRestore ? <Button variant='secondary' onClick={onRestore}>Open a saved copy</Button> : null}
          </div>
        ) : (
          <Button onClick={() => last ? onDone() : setI(i + 1)}>{last ? 'Get started' : 'Next'}</Button>
        )}
        {!last ? <button onClick={onDone} style={{ marginTop: sp.sm, background: 'none', border: 'none', color: c.text.muted, fontSize: 14, cursor: 'pointer' }}>Skip</button> : null}
      </div>
    </div>
  )
}

// Suite icons via Phosphor; thin wrappers keep the existing call sites.
function ShareIcon ({ size = 20 }) {
  return <ShareNetwork size={size} weight='regular' />
}

function TrashIcon ({ size = 18 }) {
  return <Trash size={size} weight='regular' />
}

function LinkIcon ({ size = 17 }) {
  return <Link size={size} weight='regular' />
}

// Overlapping member avatars on the space page; tap to see the full roster.
function MembersBar ({ members, onOpen }) {
  if (!members || members.length === 0) return null
  const shown = members.slice(0, 5)
  return (
    <button onClick={onOpen} aria-label='Members' style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.sm}px ${sp.base}px`, background: 'none', border: 'none', borderBottom: `1px solid ${c.divider}`, cursor: 'pointer' }}>
      <span style={{ display: 'flex' }}>
        {shown.map((m, i) => (
          <span key={m.pubkey} style={{ marginLeft: i ? -8 : 0, borderRadius: '50%', border: `2px solid ${c.surface.base}`, display: 'flex' }}>
            <Avatar name={m.displayName} avatar={m.avatar} size={26} />
          </span>
        ))}
      </span>
      <span style={{ color: c.text.secondary, fontSize: 13 }}>{members.length} {members.length === 1 ? 'member' : 'members'}</span>
      <span style={{ flex: 1 }} />
      <CaretRight size={16} color={c.text.muted} weight='regular' />
    </button>
  )
}

// Save / Open sit one above the other in the same column, so a fixed width keeps
// their right edges aligned. Padding alone does not: it sizes to the label, and
// two four-letter words still render a few pixels apart.
const BACKUP_BTN = {
  width: 92,
  padding: '8px 0',
  flexShrink: 0,
  textAlign: 'center',
  borderRadius: r.md,
  background: c.surface.input,
  fontSize: 14,
  fontFamily: FONT,
}

// The banner that explains an empty space. Copy + rule live in ../syncStatus.js
// so they are unit-tested rather than eyeballed.
function SyncBanner ({ status }) {
  const trouble = syncTrouble(status)
  if (!trouble) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: `${sp.md}px ${sp.base}px`, borderBottom: `1px solid ${c.divider}`, background: c.surface.input }}>
      <span style={{ color: c.warn, fontSize: 14, fontWeight: 400 }}>{trouble.title}</span>
      <span style={{ color: c.text.secondary, fontSize: 13, lineHeight: 1.45 }}>{trouble.body}</span>
    </div>
  )
}

export default function App () {
  const [phase, setPhase] = useState('loading')
  // Whether device-link is switched on in this build. `device:status` answers
  // `{ enabled: false }` cheaply when the flag is off, so this is safe to ask on
  // every launch. Needed at THIS level, not just in Settings, because onboarding
  // shows the link door and onboarding renders long before Settings exists.
  const [deviceLinkOn, setDeviceLinkOn] = useState(false)
  const [spaces, setSpaces] = useState([])
  const [activeSpaceId, setActiveSpaceId] = useState(null)
  const [lists, setLists] = useState([])
  const [openListId, setOpenListId] = useState(null)
  const [items, setItems] = useState([])
  const [theme, setThemeMode] = useState('dark')
  const [sheet, setSheet] = useState(null) // 'start'|'join'|'invite'|'wallet'|'spaces'|'listOptions'|'renameList'|{type:'item',item}
  const [view, setView] = useState(null) // full-screen: 'profile' | 'about'
  const [profile, setProfile] = useState(null)
  const [donateReminder, setDonateReminder] = useState(false)
  const [lnDetected, setLnDetected] = useState(false) // does the device have a Lightning wallet (drives the donation sheet)
  const [members, setMembers] = useState([])
  const [removedMembers, setRemovedMembers] = useState([]) // evicted; the owner can add them back
  // { writable, conns, members, lists } from space:status, or null before the
  // first read. Drives SyncBanner and the write block; see the method's comment
  // for why an empty space needs three different explanations.
  const [syncStatus, setSyncStatus] = useState(null)
  const [revoke, setRevoke] = useState(null)               // hard-revocation status for the active space
  const [selfPubkey, setSelfPubkey] = useState(null)
  const [banner, setBanner] = useState(null)     // transient toast (e.g. "Alex joined")
  const [navRequest, setNavRequest] = useState(null) // { groupId, listId } from a notification tap
  const [showTour, setShowTour] = useState(false)     // brief once-only guided tour on first home
  const prevMembersRef = useRef({})              // groupId -> Set(pubkey) for join detection
  const [listPicker, setListPicker] = useState(null) // { listId, current } for assigning a whole list
  const [deleteTarget, setDeleteTarget] = useState(null) // space {groupId,name} pending delete confirm
  const [draft, setDraft] = useState('')       // add-item composer (list detail)
  const [pendingUndo, setPendingUndo] = useState(null) // { snap, listId } for swipe-delete undo
  const [suggestions, setSuggestions] = useState([]) // item autocomplete from recents
  const [listDraft, setListDraft] = useState('') // add-list composer (lists overview)
  const composer = useRef(null)
  const listComposer = useRef(null)
  const navRef = useRef({}) // latest overlay state, for the shell's back handler
  const shotApplied = useRef(false) // screenshot mode: route applied once

  const gid = activeSpaceId
  const activeSpace = spaces.find((s) => s.groupId === activeSpaceId) || null

  const loadSpaces = useCallback(async () => {
    const sp = await call('spaces:list', {}).catch(() => [])
    setSpaces(sp)
    return sp
  }, [])

  const loadLists = useCallback(async (groupId) => {
    const ls = await call('list:getAll', { groupId })
    setLists(ls)
    // Stay on the overview by default; only keep a list open if it still exists.
    setOpenListId((cur) => (cur && ls.some(l => l.id === cur) ? cur : null))
    return ls
  }, [])

  const loadItems = useCallback(async (groupId, listId) => {
    if (!groupId || !listId) { setItems([]); return }
    setItems(await call('item:getAll', { groupId, listId }))
  }, [])

  // Commit a note edit and hand the freshly stored rows back to the editor, so
  // it can adopt them as its new baseline.
  //
  // This deliberately CLOSES OVER the open list rather than reading it at call
  // time. Backing out of a note sets openListId to null and unmounts the editor
  // in the same render, and the editor's unmount flush is what commits the last
  // keystrokes - so it has to target the list that was open a moment ago, not
  // the null that replaced it.
  const saveNote = useCallback(async (baseline, lines) => {
    if (!gid || !openListId) return []
    await call('note:save', { groupId: gid, listId: openListId, baseline, lines })
    const fresh = await call('item:getAll', { groupId: gid, listId: openListId })
    setItems(fresh)
    return fresh
  }, [gid, openListId])

  // Refresh the household roster, and publish our own member row once we are a
  // writable member and not yet listed (so peers can resolve our assignee pubkey).
  const loadMembers = useCallback(async (groupId, self) => {
    const ms = await call('member:getAll', { groupId }).catch(() => [])
    const rm = await call('member:getRemoved', { groupId }).catch(() => [])
    setMembers(ms)
    setRemovedMembers(rm)
    call('space:revocationStatus', { groupId }).then(setRevoke).catch(() => setRevoke(null))
    // Re-publish our roster row until it lands... but NOT if we were removed. An
    // evicted member is filtered out of `ms` forever, so without this guard the
    // "I'm missing, republish" retry would fire on every refresh tick and append a
    // member row each time, growing the log without bound (and never reappearing,
    // since only the owner can clear an eviction).
    const evictedSelf = !!self && rm.some((m) => m.pubkey === self)
    // MATCH ON EVERY DEVICE KEY OF A ROW, not just its pubkey. `ms` is COLLAPSED:
    // one person's phones are a single row carrying the representative device's
    // pubkey plus `keys` for the rest. Testing `pubkey === self` alone means the
    // phone that got collapsed away decides it is missing from the roster and
    // republishes on EVERY refresh tick - exactly the unbounded append the comment
    // above warns about, reintroduced by the collapse. Measured on hardware
    // 2026-07-29: ~1 append every 4 s, indefinitely.
    const hasKey = (m, k) => m.pubkey === k || (Array.isArray(m.keys) && m.keys.includes(k))
    const keysOf = (m) => (Array.isArray(m.keys) && m.keys.length) ? m.keys : [m.pubkey]
    if (self && !evictedSelf && !ms.some((m) => hasKey(m, self))) call('member:publish', { groupId }).catch(() => {})
    // "Someone joined" banner: fire only for a member that appears after we have
    // already seen this space's roster once (skips the initial load and self).
    //
    // Keyed on the whole key set for the same reason, and for a second one: which
    // device represents a collapsed row changes as rows are updated, so comparing
    // the representative pubkey alone reported the SAME person as newly joined
    // over and over. A person is new only when NONE of their device keys has been
    // seen - which also means linking your own second phone never announces a
    // housemate, because it is not one.
    const prev = prevMembersRef.current[groupId]
    if (prev) {
      const added = ms.find((m) => !keysOf(m).some((k) => prev.has(k)) && !hasKey(m, self))
      if (added) setBanner(`${added.displayName || 'Someone'} joined`)
    }
    prevMembersRef.current[groupId] = new Set(ms.flatMap(keysOf))
    return ms
  }, [])

  // Whether this space is actually working, so an empty one can say WHY it is
  // empty. Rides the same refresh cycle as the roster (group:updated,
  // peer:connected, 15s backstop), because the two answers change together: a
  // device that has just been admitted becomes writable and gains a roster in the
  // same tick.
  const loadSyncStatus = useCallback(async (groupId) => {
    setSyncStatus(await call('space:status', { groupId }).catch(() => null))
  }, [])

  // Boot.
  useEffect(() => {
    setThemeMode(loadTheme())
    ;(async () => {
      await call('init', {})
      call('profile:get', {}).then(setProfile).catch(() => {})
      call('identity:get', {}).then((r) => setSelfPubkey(r?.pubkey || null)).catch(() => {})
      // Fire-and-forget: a build without the flag answers `{ enabled: false }`,
      // and a failure here must not hold up boot. Onboarding just shows its
      // original three doors until (and unless) this resolves true.
      call('device:status', {}).then((r) => setDeviceLinkOn(!!r?.enabled)).catch(() => {})
      const sp = await loadSpaces()
      if (sp.length) {
        // Reopen the space we were last in, if it is still one we are in.
        const saved = BOOT_PLACE.groupId
        setActiveSpaceId(sp.some((s) => s.groupId === saved) ? saved : sp[0].groupId)
        setPhase('home')
      } else setPhase('onboarding')
    })().catch((e) => { console.error(e); setPhase('onboarding') })
  }, [loadSpaces])

  // Remember where we are, so a reload (notably the WebView freeze recovery) can
  // put us back. Written on change rather than on unload: the recovery terminates
  // the render process outright, so there is no unload event to hook.
  useEffect(() => { if (activeSpaceId) savePlace({ groupId: activeSpaceId }) }, [activeSpaceId])

  // Reopen the list we had open, once its space's lists have arrived. Runs at
  // most once per load: `restoredPlace` latches immediately, so this can never
  // fight the user by yanking them back to an old list later in the session.
  const restoredPlace = useRef(false)
  useEffect(() => {
    if (restoredPlace.current || phase !== 'home' || !lists.length) return
    restoredPlace.current = true
    if (BOOT_PLACE.listId && lists.some((l) => l.id === BOOT_PLACE.listId)) setOpenListId(BOOT_PLACE.listId)
  }, [phase, lists])
  // Persist only AFTER the restore has had its chance, so the initial null does
  // not overwrite the list we are about to reopen.
  useEffect(() => { if (restoredPlace.current) savePlace({ listId: openListId }) }, [openListId])

  // Screenshot mode: once home and the active space's lists have loaded, route
  // to the scene's target screen (open a list by name, or open a sheet). Applied
  // once. No effect in production (SCREENSHOT_SCENE is null unless the shell
  // injected a scene from a pear://pearlist/screenshot/<N> launch deep link).
  useEffect(() => {
    if (SCREENSHOT_SCENE == null || shotApplied.current || phase !== 'home') return
    const route = SCREENSHOT_ROUTE || {}
    if (route.openList) {
      const l = lists.find((x) => x.name === route.openList)
      if (!l) return // lists not loaded yet; re-run when they are
      setOpenListId(l.id)
    }
    if (route.sheet) setSheet(route.sheet)
    if (route.view) setView(route.view)
    shotApplied.current = true
  }, [phase, lists])

  // Global haptics: one delegated listener buzzes on every tap of any button or
  // tappable (and any future one), so controls need no per-onClick wiring. Click
  // phase means it fires on a real tap, not on scroll/swipe. `data-haptic` opts
  // an element into a stronger cue ('warn' destructive, 'success' completing).
  useEffect(() => {
    const onTap = (e) => {
      const el = e.target?.closest?.('button, a, [role="button"], label, summary, input[type="checkbox"], input[type="radio"]')
      if (!el || el.disabled) return
      haptic(el.dataset?.haptic || 'light')
    }
    document.addEventListener('click', onTap, true)
    return () => document.removeEventListener('click', onTap, true)
  }, [])

  // Load the active space's lists whenever the space changes.
  useEffect(() => {
    if (phase !== 'home' || !gid) { setLists([]); setOpenListId(null); return }
    loadLists(gid)
  }, [phase, gid, loadLists])

  // Storage retention now runs in the worklet on a timer (roadmap #4 P2), so the
  // UI no longer schedules it. space:retain remains available for manual use.

  // Live updates: the worklet emits `group:updated` whenever the active space's
  // Autobase view changes (a local edit or a replicated remote change), so we
  // refetch on demand instead of polling. This covers lists + the open list's
  // items + the roster (all one base view). `peer:connected` forces an immediate
  // catch-up on (re)connect, and a slow backstop covers any missed event.
  useEffect(() => {
    if (phase !== 'home' || !gid) return
    const refresh = () => { loadLists(gid); loadItems(gid, openListId); loadMembers(gid, selfPubkey); loadSyncStatus(gid) }
    refresh()
    const offUpdated = on('group:updated', (d) => { if (!d || d.groupId === gid) refresh() })
    const offPeer = on('peer:connected', () => refresh())
    const backstop = setInterval(refresh, 15000)
    return () => { offUpdated(); offPeer(); clearInterval(backstop) }
  }, [phase, gid, openListId, selfPubkey, loadItems, loadLists, loadMembers, loadSyncStatus])

  // In-app banner when a peer assigns me an item (foreground case). The OS
  // notification, if enabled, is raised separately by the shell.
  useEffect(() => on('notify:assigned', (d) => setBanner(
    d?.kind === 'list'
      ? `You were assigned the list "${d?.text || 'a list'}"`
      : `You were assigned "${d?.text || 'an item'}"`
  )), [])
  // In-app banner when someone completes an item on a list I created.
  useEffect(() => on('notify:completed', (d) => setBanner(
    d?.allDone
      ? `${d?.kind === 'chore' ? 'Chore list' : 'List'} "${d?.listName || 'a list'}" is all done`
      : `"${d?.item || 'an item'}" was completed in "${d?.listName || 'a list'}"`
  )), [])

  // Show the brief guided tour once. On a first run that is during onboarding,
  // once the name is set and before a space exists (the tour explains what a
  // space is, then hands off to create/join). Existing installs have no
  // onboarding phase left, so they pick it up on their next visit to home, which
  // is what a TOUR_KEY bump relies on.
  useEffect(() => {
    if (phase !== 'home' && !(phase === 'onboarding' && profile?.displayName)) return
    try { if (!localStorage.getItem(TOUR_KEY)) setShowTour(true) } catch {}
  }, [phase, profile?.displayName])
  function dismissTour () { try { localStorage.setItem(TOUR_KEY, '1') } catch {}; setShowTour(false) }
  // Replay from Settings: back to Lists so the tour lands over the screen it
  // describes, not over the Settings panel.
  function replayTour () { setOpenListId(null); setView(null); setShowTour(true) }

  // The worklet can change our profile without the UI asking: a freshly linked
  // phone adopts the name and avatar of the phone it linked to. Without this the
  // screen keeps showing the old (or empty) name until something else happens to
  // re-read it, which on the onboarding path is never.
  useEffect(() => on('profile:changed', () => { call('profile:get', {}).then(setProfile).catch(() => {}) }), [])

  // Notification tap -> open the related space (and list, if any). Requested by
  // the shell (notify:open); applied once we are home and that space has loaded
  // (covers a cold start where the tap arrives before spaces are ready).
  useEffect(() => on('notify:open', (d) => { if (d?.groupId) setNavRequest(d) }), [])
  useEffect(() => {
    if (!navRequest || phase !== 'home') return
    if (!spaces.some((s) => s.groupId === navRequest.groupId)) return
    setActiveSpaceId(navRequest.groupId)
    setOpenListId(navRequest.listId || null)
    setNavRequest(null)
  }, [navRequest, phase, spaces])

  // Two-week donation nudge: check once on reaching home, show only once ever
  // (mark shown as soon as it surfaces). Runs on iOS too now that the App Store
  // release has shipped and the donation UI is no longer platform-gated.
  useEffect(() => {
    if (phase !== 'home') return
    let done = false
    call('donation:status', {}).then((s) => {
      if (!done && s?.due) { setDonateReminder(true); call('donation:dismiss', {}).catch(() => {}) }
    }).catch(() => {})
    return () => { done = true }
  }, [phase])

  // A space we're in was deleted by its owner: forget it and move off it.
  useEffect(() => {
    const off = on('space:deleted', ({ groupId }) => {
      (async () => {
        await call('space:forget', { groupId }).catch(() => {})
        const sp = await loadSpaces()
        setOpenListId(null)
        setActiveSpaceId((cur) => (cur === groupId ? (sp[0]?.groupId || null) : cur))
        if (sp.length === 0) setPhase('onboarding')
        setBanner('That space was deleted by its owner.')
      })()
    })
    return off
  }, [loadSpaces])

  // Invite deep link: the shell forwards the opened URL
  // (https://peerloomllc.com/pearlist/join#<blob> or pear://pearlist/join?...).
  // Parse the blob and join. Registered once; joinSpace closes over stable setters.
  useEffect(() => {
    const off = on('deeplink:invite', ({ url }) => {
      joinSpace(url).catch((e) => setBanner(problem('Could not open that invite', e)))
    })
    return off
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Android back button / gesture: tell the shell whether there is an in-app
  // overlay to dismiss, so it consumes the press instead of exiting the app.
  navRef.current = { donateReminder, listPicker, sheet, view, openListId }
  useEffect(() => {
    const canBack = !!(donateReminder || listPicker || sheet || view || openListId)
    call('shell:navState', { canBack }).catch(() => {})
  }, [donateReminder, listPicker, sheet, view, openListId])

  // The shell forwards a hardware back press as a 'back' event when canBack was
  // true; close the top-most layer (registered once, reads latest via navRef).
  useEffect(() => on('back', () => {
    const n = navRef.current
    if (n.donateReminder) setDonateReminder(false)
    else if (n.listPicker) setListPicker(null)
    else if (n.sheet) { setSheet(null); setDeleteTarget(null) }
    else if (n.view) setView(null)
    else if (n.openListId) setOpenListId(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  // Auto-dismiss the transient banner.
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner(null), 4000)
    return () => clearTimeout(t)
  }, [banner])

  // The undo window: after 3s the delete stands. Also cleared when leaving the list.
  useEffect(() => {
    if (!pendingUndo) return
    const t = setTimeout(() => setPendingUndo(null), 3000)
    return () => clearTimeout(t)
  }, [pendingUndo])
  useEffect(() => { setPendingUndo(null) }, [openListId])

  const openList = lists.find(l => l.id === openListId) || null
  const isNoteList = openList?.kind === 'note'

  // Grocery aisle categorization, step 1 (keyword pass): when a grocery list is
  // open with items lacking a category, ask the worklet to classify them with the
  // fast offline keyword classifier, then reload so they regroup under aisle
  // headers. No-ops once every item has a category, so it settles after one pass.
  useEffect(() => {
    if (openList?.kind !== 'grocery' || !gid || !openListId) return
    if (!items.some((i) => !i.category)) return
    let cancelled = false
    call('ai:categorizeList', { groupId: gid, listId: openListId })
      .then(() => { if (!cancelled) loadItems(gid, openListId) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [openList?.kind, gid, openListId, items, loadItems])

  // On-device AI status (consent + model download state), from the RN shell.
  // Device-local grocery view prefs (collapsed aisles + custom aisle/item order),
  // per list, persisted to localStorage. Tapping a header toggles collapse;
  // long-press drag reorders (see useAisleDrag).
  // `auto` is the subset of `collapsed` that the auto-collapse rule closed, so
  // unchecking reopens only those and never a group the user shut by hand.
  // `forList` marks which list the loaded prefs are for. Only the auto-collapse
  // effect reads it, to keep from acting on the previous list's state in the render
  // between opening a list and its prefs landing. Never persisted (state only).
  const [aisleView, setAisleViewState] = useState({ collapsed: [], auto: [], aisleOrder: [], itemOrder: [], forList: null })
  useEffect(() => { setAisleViewState({ collapsed: [], auto: [], aisleOrder: [], itemOrder: [], ...(openListId ? loadAisleView(openListId) : {}), forList: openListId }) }, [openListId])
  const patchAisleView = useCallback((patch) => {
    setAisleViewState((prev) => ({ ...prev, ...patch }))
    if (openListId) saveAisleView(openListId, patch)
  }, [openListId])
  const collapsedSet = new Set(aisleView.collapsed || [])
  const [autoCollapse, setAutoCollapseState] = useState(loadAutoCollapse)
  const setAutoCollapse = useCallback((on) => { setAutoCollapseState(!!on); saveAutoCollapse(on) }, [])
  const toggleAisle = useCallback((aisle) => {
    const cur = aisleView.collapsed || []
    // Tapping a header is the user taking over: the group stops counting as
    // auto-collapsed, so the rule leaves it alone until it is finished afresh.
    patchAisleView({
      collapsed: cur.includes(aisle) ? cur.filter((a) => a !== aisle) : [...cur, aisle],
      auto: (aisleView.auto || []).filter((a) => a !== aisle),
    })
  }, [aisleView.collapsed, aisleView.auto, patchAisleView])

  // Grocery lists group by a fixed aisle taxonomy (+ AI); other lists group by
  // user-defined SECTIONS (same category field, no built-ins, no AI) once the
  // user makes one. Both reuse the same grouped view / drag / collapse machinery.
  const isGroceryList = openList?.kind === 'grocery'
  const groupBuiltins = isGroceryList ? aisles.AISLES : []
  const fallbackLabel = isGroceryList ? aisles.FALLBACK : 'Ungrouped'
  const groupNoun = isGroceryList ? 'aisle' : 'section'
  // Sections in use. Never for a note: its rows are lines of text, and a list
  // converted to a note can still carry stale aisle categories that would
  // otherwise light up the (unreachable) collapse-all option.
  const grouped = !isNoteList && (isGroceryList || items.some((i) => i.category))

  // Drag: reorder items/groups (device-local) or drop an item into another group
  // to re-file it (recategorize, which syncs via ai:setCategory).
  const listScrollRef = useRef(null)
  const recategorizeItem = useCallback((itemId, aisle) => {
    if (!gid || !openListId) return
    if (isGroceryList) rememberOverride(items.find((i) => i.id === itemId)?.text, aisle) // learn corrections (grocery classifier only)
    call('ai:setCategory', { groupId: gid, listId: openListId, itemId, category: aisle, by: 'user' }).then(() => loadItems(gid, openListId)).catch(() => {})
  }, [gid, openListId, loadItems, items, isGroceryList])
  const { dragProps, dragOver, lifted, didDrag } = useAisleDrag({
    items, aisleView, scrollRef: listScrollRef, builtins: groupBuiltins,
    onReorderItems: (order) => patchAisleView({ itemOrder: order }),
    onReorderAisles: (order) => patchAisleView({ aisleOrder: order }),
    onRecategorize: recategorizeItem,
  })

  // Just-added item: scroll it into view (it can land mid-list under its aisle,
  // or off-screen on a long list) and briefly flash it. Waits until no sheet is
  // open (groceries pop a quantity sheet on add) and the row has rendered.
  const [flashId, setFlashId] = useState(null)
  useEffect(() => {
    if (!flashId || sheet) return
    // If the new item landed in a collapsed aisle, expand it first (so the row is
    // actually visible), then let the effect re-run to scroll + flash it.
    const it = items.find((i) => i.id === flashId)
    if (it && grouped) {
      const aisle = aisles.bucketOf(it.category)
      if ((aisleView.collapsed || []).includes(aisle)) {
        patchAisleView({ collapsed: (aisleView.collapsed || []).filter((a) => a !== aisle) })
        return
      }
    }
    const el = listScrollRef.current?.querySelector(`[data-item-id="${(window.CSS && CSS.escape) ? CSS.escape(flashId) : flashId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setFlashId(null), 1600)
    return () => clearTimeout(t)
  }, [flashId, sheet, items, aisleView.collapsed, openList?.kind, patchAisleView])

  // Collapse/expand every aisle at once (grouped grocery view).
  const presentAisles = [...new Set(items.map((i) => aisles.bucketOf(i.category)))]
  const allCollapsed = presentAisles.length > 0 && presentAisles.every((a) => collapsedSet.has(a))
  const toggleCollapseAll = useCallback(() => {
    const present = [...new Set(items.map((i) => aisles.bucketOf(i.category)))]
    const collapsed = present.length > 0 && present.every((a) => (aisleView.collapsed || []).includes(a))
    patchAisleView({ collapsed: collapsed ? [] : present, auto: [] }) // a deliberate collapse-all, so nothing is the rule's to reopen
  }, [items, aisleView.collapsed, patchAisleView])

  // Auto-collapse a finished group (GH #90), when the "Tidy finished aisles"
  // setting is on. The decision itself lives in src/autoCollapse.js, which explains
  // why it is transition-based; `doneRef` is the baseline it needs. Reset when the
  // list changes or the setting flips, so switching it on acts on the list as it
  // stands rather than waiting for the next check-off.
  const doneRef = useRef(null)
  useEffect(() => { doneRef.current = null }, [openListId, autoCollapse])
  useEffect(() => {
    if (!autoCollapse || !grouped || !openListId) return
    // Both the prefs and the rows are loaded per list, a render apart from the
    // switch itself. Acting on either while it still holds the previous list's
    // data would write that list's aisles into this list's prefs.
    if (aisleView.forList !== openListId) return
    if (items.length && items[0].listId && items[0].listId !== openListId) return
    const next = nextCollapseState({ items, prevDone: doneRef.current, collapsed: aisleView.collapsed, auto: aisleView.auto })
    doneRef.current = next.done
    if (next.changed) patchAisleView({ collapsed: next.collapsed, auto: next.auto })
  }, [autoCollapse, grouped, openListId, items, aisleView.collapsed, aisleView.auto, aisleView.forList, patchAisleView])

  // There is no AI fallback any more (removed 2026-07-26): an item the keyword
  // pass cannot place simply rests in Other. Measured over 1702 calls, the model
  // placed 37% of those correctly at 4-6.5s each, so Other is both faster and more
  // honest. Correcting an item by hand still teaches this device (rememberOverride).

  async function createSpace (name) {
    const { groupId } = await call('group:create', { name })
    await call('space:init', { groupId, name }).catch(() => {}) // claim ownership before anyone joins
    call('member:publish', { groupId }).catch(() => {}) // owner is writable now
    await loadSpaces()
    setActiveSpaceId(groupId); setOpenListId(null)
    setPhase('home'); setSheet('invite')
  }
  async function joinSpace (inviteInput) {
    const inviteKey = parseInvite(inviteInput)
    if (!inviteKey) throw new Error('That does not look like an invite link.')
    const { groupId } = await call('group:join', { inviteKey })
    await loadSpaces()
    setActiveSpaceId(groupId); setOpenListId(null); setPhase('home'); setSheet(null)
    call('member:publish', { groupId }).catch(() => {}) // retried on each refresh until writable
  }

  // Consume a pairing link: this phone adopts the identity shown on the other one
  // and is seeded with its spaces. Lives here rather than in Settings because
  // ONBOARDING needs it too - a replacement phone has no Settings to reach, which
  // is exactly the gap that made linking undiscoverable (see Onboarding).
  //
  // The spaces arrive through the group plugin's seedGroups, inside the WORKLET.
  // Nothing tells the UI about them, so without the reload the pairing looks like
  // it did nothing until the next launch - measured on hardware 2026-07-28, six
  // spaces joined and none on screen. Same shape as the restored-templates gap.
  async function linkThisDevice (url) {
    const problem = pairLinkProblem(url)
    if (problem) throw new Error(problem)
    await call('device:consumePairLink', { url })
    const sp = await loadSpaces()
    setSheet(null)
    // Navigate ONLY from onboarding, where there is nowhere to be. A phone that
    // just linked has whatever the other one had, so landing in the first space
    // is the proof it worked - dropping the user on "no spaces yet" reads as a
    // failed pairing. From Settings the user is already somewhere they chose to
    // be, and yanking them into a space would be the app losing their place.
    const first = sp && sp[0]
    if (first && phase === 'onboarding') { setActiveSpaceId(first.groupId); setOpenListId(null); setPhase('home') }
    setBanner(first
      ? 'Linked. This phone now shares your spaces.'
      : 'Linked. No spaces on the other phone yet, so there is nothing to show.')
  }
  // Export reads only, so it works on a space this device cannot write to - which
  // is exactly the space someone most needs to get their lists out of.
  // EVERY space on the phone, not the one on screen: "back up my lists" means the
  // phone. Reads only, so a space this device cannot sync is saved too - which is
  // the one somebody most needs a copy of.
  async function exportBackup () {
    try {
      // The worklet cannot read these: Learned Aisles and the hand-made aisle
      // names live in the WebView's localStorage. Collected per space by groupId,
      // because the import mints new ids and only the worklet knows the mapping.
      const customAisles = {}
      for (const sp of spaces) {
        const names = loadCustomAisles(sp.groupId)
        if (names.length) customAisles[sp.groupId] = names
      }
      const { json, filename, counts } = await call('backup:export', { learnedAisles: loadOverrides(), customAisles })
      const saved = await call('shell:saveFile', { filename, content: json })
      if (saved && saved.canceled) return // they backed out of the folder picker
      const parts = [
        `${counts.spaces} space${counts.spaces === 1 ? '' : 's'}`,
        `${counts.lists} list${counts.lists === 1 ? '' : 's'}`,
        `${counts.items} item${counts.items === 1 ? '' : 's'}`,
      ]
      // Only mentioned when there are some, so the common case stays short.
      if (counts.templates) parts.push(`${counts.templates} saved list${counts.templates === 1 ? '' : 's'}`)
      // Where it went matters as much as that it worked: a file nobody can find
      // again is not a backup.
      setBanner('Saved ' + parts.join(', ') + (saved && saved.where ? ` to ${saved.where}` : ''))
    } catch (e) {
      alert(problem('Could not save a copy', e))
    }
  }
  // Always NEW spaces, never a merge (see backup:import). So the worst case of a
  // wrong file is a space you delete again, not a household list silently doubled.
  async function importBackup () {
    try {
      const picked = await call('shell:pickFile', {})
      if (!picked || picked.canceled) return
      if (!String(picked.content || '').trim()) throw new Error('That file is empty.')
      const { spaces, learnedAisles, counts } = await call('backup:import', { jsonString: picked.content })
      // The localStorage half, which only the UI can write. MERGE for the learned
      // aisles (an entry this device already has is a more recent correction than
      // one from a file), and per space for the aisle names, keyed by the id the
      // space was just given.
      mergeOverrides(learnedAisles)
      for (const sp of (spaces || [])) {
        for (const name of (sp.customAisles || [])) rememberCustomAisle(sp.groupId, name)
      }
      await loadSpaces()
      // Saved lists are loaded once at mount, so without this the restored ones
      // sit in localDb unseen until the next launch - which reads as "my saved
      // lists did not come back". Caught on-device 2026-07-28.
      await loadTemplates()
      // A notice, not a banner, because it asks the user to go and DO something,
      // and a banner they miss is the same as never having said it.
      //
      // Shown on every restore, not only when reminders were lost: we cannot tell
      // whether they had any, precisely because remindAt is dropped at export
      // time, so the file carries no trace of them. Saying it once to someone who
      // had none beats silently losing them for someone who did.
      //
      // BEFORE the phase change, deliberately. ConfirmHost is rendered in both the
      // onboarding and the home trees, so flipping phase mid-prompt would unmount
      // and remount it - dropping the pending resolve and hanging this await. Ask
      // while the screen is still whatever it already was, then move.
      await askConfirm({
        title: 'Your lists are back',
        message: `${counts.spaces} space${counts.spaces === 1 ? '' : 's'} and ${counts.items} item${counts.items === 1 ? '' : 's'} restored. Reminders are not kept in a saved copy, so any you had set on individual items need setting again, and the daily reminder is worth checking in Settings. Repeating chores kept their schedule.`,
        confirmLabel: 'Got it',
        noCancel: true,
      })
      // Land in the first restored space, so the import is visibly there rather
      // than something the user has to go looking for.
      const first = spaces && spaces[0]
      if (first) { setActiveSpaceId(first.groupId); setOpenListId(null); setPhase('home'); setSheet(null) }
    } catch (e) {
      alert(problem('Could not open that file', e))
    }
  }
  function switchSpace (groupId) {
    setActiveSpaceId(groupId); setOpenListId(null); setSheet(null)
  }
  async function deleteSpace (targetId) {
    const id = targetId || activeSpaceId; if (!id) return
    setSheet(null); setDeleteTarget(null)
    try { await call('space:delete', { groupId: id }) } catch (e) { alert(problem('Could not delete space', e)); return }
    const sp = await loadSpaces()
    // Only move off if we deleted the space we were viewing.
    if (!sp.some((s) => s.groupId === activeSpaceId)) { setOpenListId(null); setActiveSpaceId(sp[0]?.groupId || null) }
    if (sp.length === 0) setPhase('onboarding')
    setBanner('Space deleted.')
  }
  // Owner-only: drop a member from the space (the stale-device case). Reversible
  // with a fresh invite, so the confirm says so. It does NOT revoke a device that
  // still holds the space, and the copy is careful not to imply otherwise.
  async function removeMember (m) {
    const name = m.displayName || 'this member'
    const ok = await askConfirm({
      title: `Remove ${name}?`,
      // Honest: re-inviting them is NOT enough on its own, because only the owner
      // can clear an eviction. "Add back" on this screen is the way back.
      message: `${name} stops showing as a member of this space. Anything they added stays, and you can add them back from this screen.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    let res
    try { res = await call('member:remove', { groupId: gid, pubkey: m.pubkey }) } catch (e) { alert(problem('Could not remove', e)); return }
    await loadMembers(gid, selfPubkey)
    // Be honest when we could only HIDE them. Cutting a device off needs its writer
    // binding, which only exists if it has been online since Stronger removal was
    // turned on. Without it the removal is hide-only, and saying otherwise would be
    // a lie about a security property.
    if (revoke?.armed && res && res.revoked === false) {
      setBanner(`${name} removed from the list, but their device could not be cut off (it has not been online since Stronger removal was turned on).`)
    } else {
      setBanner(`${name} removed.`)
    }
  }
  // Turn on hard revocation for this space. ONE WAY, and the copy says so: it
  // changes how every peer applies writer ops, and a peer that has not updated would
  // silently fork the space, which is why it stays off until everyone has.
  // It stops a removed device WRITING. It cannot stop it READING - no design can
  // (it keeps the space's key), so the copy must not imply otherwise.
  async function armRevocation () {
    const ok = await askConfirm({
      title: 'Stronger removal?',
      message: 'Removed devices will also lose the ability to CHANGE anything in this space, not just disappear from the member list. They can still see what they already have: turning this on cannot take that away. This cannot be undone, and every member has to have updated first.',
      confirmLabel: 'Turn on',
    })
    if (!ok) return
    try { await call('space:armRevocation', { groupId: gid }) } catch (e) { alert(terminated(e.message)); return }
    await loadMembers(gid, selfPubkey)
    setBanner('Stronger removal is on.')
  }
  async function restoreMember (m) {
    try { await call('member:restore', { groupId: gid, pubkey: m.pubkey }) } catch (e) { alert(problem('Could not add back', e)); return }
    await loadMembers(gid, selfPubkey)
    setBanner(`${m.displayName || 'Member'} added back.`)
  }
  // Anyone can leave a space they are in (the owner deletes it instead). Retires
  // our own roster row, then forgets the space locally.
  async function leaveSpace (space) {
    const ok = await askConfirm({
      title: `Leave ${space?.name || 'this space'}?`,
      message: 'You stop showing as a member and this space is removed from this device. Its lists stay for everyone else. You can rejoin with a new invite.',
      confirmLabel: 'Leave',
      danger: true,
    })
    if (!ok) return
    setSheet(null)
    try { await call('space:leave', { groupId: space.groupId }) } catch (e) { alert(problem('Could not leave', e)); return }
    const sp = await loadSpaces()
    if (!sp.some((s) => s.groupId === activeSpaceId)) { setOpenListId(null); setActiveSpaceId(sp[0]?.groupId || null) }
    if (sp.length === 0) setPhase('onboarding')
    setBanner('You left the space.')
  }
  async function assignList (listId, assignee) {
    await call('list:assign', { groupId: gid, listId, assignee })
    await loadLists(gid)
  }
  async function addItemText (text) {
    const t = String(text || '').trim(); if (!t || !gid || !openListId) return
    setDraft(''); setSuggestions([])
    composer.current?.blur?.() // dismiss the keyboard; show the full list
    // Groceries: choose quantity FIRST, then actually add on confirm/dismiss. The
    // row is added only after the quantity sheet closes, so it is not inserted
    // underneath the sheet where the just-added flash would be missed.
    if (openList?.kind === 'grocery') { setSheet({ type: 'qty', text: t }); return }
    const { itemId } = await call('item:add', { groupId: gid, listId: openListId, text: t })
    await loadItems(gid, openListId)
    if (itemId) setFlashId(itemId) // scroll to + flash the new row
  }
  const addItem = () => addItemText(draft)

  // Item autocomplete: suggest previously-added items as you type (device-local).
  useEffect(() => {
    const q = draft.trim()
    if (!openListId || !q) { setSuggestions([]); return }
    let live = true
    const t = setTimeout(() => {
      call('item:suggest', { prefix: q, limit: 4 })
        .then((s) => { if (live) setSuggestions((s || []).filter((x) => x.toLowerCase() !== q.toLowerCase()).slice(0, 4)) })
        .catch(() => {})
    }, 120)
    return () => { live = false; clearTimeout(t) }
  }, [draft, openListId])
  async function toggleItem (item) {
    const nowChecked = !item.checked
    setItems((cur) => cur.map(i => i.id === item.id ? { ...i, checked: nowChecked } : i)) // optimistic
    await call('item:toggle', { groupId: gid, listId: openListId, itemId: item.id, checked: nowChecked })
    await loadItems(gid, openListId)
    // Checking this item just completed the list (every item now checked) ->
    // offer to delete it. `items` is the pre-toggle state, so this fires only on
    // the transition, when the LAST open item is checked. Skipped on chore lists:
    // those are a parent/child setup where a child finishing chores should not be
    // prompted to delete the (typically recurring, parent-owned) list.
    if (nowChecked && openList?.kind !== 'chore' && items.length > 0 && items.every(i => i.id === item.id || i.checked)) setSheet('listComplete')
  }
  // Swipe-delete: remove the item, then offer a 3s undo. Undo re-creates it with
  // its fields (a new row, since the delete is a no-resurrection tombstone).
  async function swipeDeleteItem (item) {
    const snap = { text: item.text, qty: item.qty, note: item.note, url: item.url, assignee: item.assignee, checked: !!item.checked }
    setItems((cur) => cur.filter(i => i.id !== item.id)) // optimistic
    await call('item:delete', { groupId: gid, listId: openListId, itemId: item.id })
    await loadItems(gid, openListId)
    setPendingUndo({ snap, listId: openListId })
  }
  async function undoDelete () {
    const p = pendingUndo; if (!p) return
    setPendingUndo(null)
    try {
      const s = p.snap
      const { itemId } = await call('item:add', { groupId: gid, listId: p.listId, text: s.text, qty: s.qty })
      if (s.note || s.url) await call('item:edit', { groupId: gid, listId: p.listId, itemId, note: s.note || '', url: s.url || '' })
      if (s.assignee) await call('item:assign', { groupId: gid, listId: p.listId, itemId, assignee: s.assignee })
      if (s.checked) await call('item:toggle', { groupId: gid, listId: p.listId, itemId, checked: true })
      await loadItems(gid, openListId)
    } catch {}
  }
  // Adding a list is two steps: submit the name (+ or Enter) opens the category
  // prompt; picking a category finalizes creation. The typed name stays in the
  // composer while the sheet is open, so dismissing the sheet cancels without
  // losing it.
  function beginAddList () {
    const name = listDraft.trim(); if (!name || !gid) return
    listComposer.current?.blur?.()   // dismiss the keyboard so the sheet is unobstructed
    setSheet('newListCategory')
  }
  async function createListWithKind (kind) {
    const name = listDraft.trim()
    if (!name || !gid) { setSheet(null); return }
    await call('list:create', { groupId: gid, name, kind })
    setListDraft(''); setSheet(null)
    await loadLists(gid)               // new list appears in the overview; do not auto-open
  }
  // Saved list templates. Device-local by design (see
  // proposals/2026-07-23-saved-list-templates.md), so nothing here touches the
  // space and other members never see a template - only the list it produces.
  const [templates, setTemplates] = useState([])
  const loadTemplates = useCallback(async () => {
    try { const r = await call('template:list', {}); setTemplates(Array.isArray(r) ? r : []) } catch {}
  }, [])
  useEffect(() => { loadTemplates() }, [loadTemplates])
  async function saveOpenListAsTemplate () {
    if (!gid || !openListId) return
    try {
      await call('template:save', { groupId: gid, listId: openListId })
      await loadTemplates()
      setSheet('templates')   // the saved template is now in the list: that IS the confirmation
    } catch (e) {
      setSheet(null)
      alert(String(e?.message || e).includes('empty') ? 'Add an item first - there is nothing to save yet.' : 'Could not save that as a template.')
    }
  }
  async function useTemplate (t) {
    if (!gid || !t) return
    setSheet(null)
    await call('template:apply', { groupId: gid, id: t.id })
    await loadLists(gid)      // the new list appears in the overview; do not auto-open
  }
  async function deleteTemplate (t) {
    if (!t) return
    const ok = await askConfirm({ title: 'Forget this template?', message: `"${t.name}" is only on this phone, so this does not affect anyone else in the space.`, confirmLabel: 'Forget', danger: true })
    if (!ok) return
    await call('template:delete', { id: t.id })
    await loadTemplates()
  }
  async function setListKind (listId, kind) {
    if (!gid || !listId) return
    await call('list:setKind', { groupId: gid, listId, kind })
    await loadLists(gid); setSheet(null)
  }
  async function setNotifyMode (listId, mode) {
    if (!gid || !listId) return
    await call('list:setNotifyOnComplete', { groupId: gid, listId, mode })
    await loadLists(gid); setSheet(null)
  }
  async function renameList (name) {
    const n = (name || '').trim(); if (!n || !openListId) return
    await call('list:rename', { groupId: gid, listId: openListId, name: n })
    await loadLists(gid); setSheet(null)
  }
  async function deleteOpenList () {
    if (!openListId) return
    await call('list:delete', { groupId: gid, listId: openListId })
    setOpenListId(null); setSheet(null); await loadLists(gid)
  }
  // Deleting from the options sheet asks first. An item delete is forgiving (it
  // leaves an Undo toast), but a list delete is not: it writes a shared tombstone,
  // so it is gone for everyone in the space, no-resurrection means it cannot come
  // back, and there is no undo. A note raises the stakes again, since one holds
  // typed prose rather than a few retypeable checkboxes.
  //
  // Deliberately NOT inside deleteOpenList: ListCompleteSheet ("All done - delete
  // the list?") is already a confirmation, and routing it through here too would
  // ask twice for one decision.
  async function confirmDeleteOpenList () {
    if (!openList) return
    const isNote = openList.kind === 'note'
    const ok = await askConfirm({
      title: `Delete "${openList.name || (isNote ? 'this note' : 'this list')}"?`,
      message: isNote
        ? 'This removes the note for everyone in the space, along with everything written in it. This cannot be undone.'
        : 'This removes the list for everyone in the space, along with its items. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await deleteOpenList()
  }
  // Reset a list: uncheck every checked item (the recurring-chore action - re-open
  // the list for a new round). Unchecks are shared item edits, so they replicate to
  // everyone, which is the point for a shared chore list.
  async function resetOpenList () {
    if (!gid || !openListId) return
    const checked = items.filter((i) => i.checked)
    setSheet(null)
    if (!checked.length) return
    setItems((cur) => cur.map((i) => ({ ...i, checked: false }))) // optimistic
    for (const it of checked) await call('item:toggle', { groupId: gid, listId: openListId, itemId: it.id, checked: false })
    await loadItems(gid, openListId)
  }
  async function applyTheme (mode) { setTheme(mode); setThemeMode(mode) }
  // Bottom-nav tab switch: always leave any open list (the tab bar only shows on
  // top-level screens) and map the tab to the view state.
  const goTab = useCallback((key) => { setOpenListId(null); setView(key === 'settings' ? 'profile' : key === 'about' ? 'about' : null) }, [])

  if (phase === 'loading') {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={28} /></div>
  }
  if (phase === 'onboarding') {
    // First run: require a display name (+ optional photo) before create/join.
    if (!profile?.displayName) {
      // The link sheet has to be mounted HERE too, not only on the doors screen
      // below: this branch returns early, so a phone that has not been named yet
      // would otherwise have nowhere for "I already use PearList" to open.
      return (
        <>
          <NameSetup profile={profile} onDone={() => call('profile:get', {}).then(setProfile).catch(() => {})}
            onLink={deviceLinkOn ? () => setSheet('link') : null} />
          <LinkDeviceSheet open={sheet === 'link'} onClose={() => setSheet(null)} onLink={linkThisDevice} />
          <ConfirmHost />
        </>
      )
    }
    // The tour runs over this screen and ends on its create/join step, so those
    // buttons close the tour (it has been seen) and open the same sheets the
    // screen behind it would. Backing out of a sheet lands on that screen, which
    // offers the same two choices, so there is no dead end.
    return (
      <>
        <Onboarding onStart={() => setSheet('start')} onJoin={() => setSheet('join')} onRestore={importBackup}
          onLink={deviceLinkOn ? () => setSheet('link') : null} />
        <GuidedTour open={showTour} onDone={dismissTour}
          onCreate={() => { dismissTour(); setSheet('start') }}
          onJoin={() => { dismissTour(); setSheet('join') }}
          onRestore={() => { dismissTour(); importBackup() }} />
        <StartSheet open={sheet === 'start'} onClose={() => setSheet(null)} onCreate={createSpace} />
        <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} onJoin={joinSpace} />
        <LinkDeviceSheet open={sheet === 'link'} onClose={() => setSheet(null)} onLink={linkThisDevice} />
        {/* Restoring can start from here (and from the tour), and its notice goes
            through askConfirm - which is a no-op unless a ConfirmHost is mounted. */}
        <ConfirmHost />
      </>
    )
  }

  return (
    <div style={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxWidth: 600, margin: '0 auto' }}>
      {banner ? <Banner text={banner} onClose={() => setBanner(null)} /> : null}
      {openListId !== null ? (
        // ===== List detail: the items of the open list + add-item bar =====
        <>
          <DetailHeader title={openList?.name || 'List'} assignee={openList?.assignee} members={members} onBack={() => setOpenListId(null)} onOptions={() => setSheet('listOptions')} />
          {/* Also here, not just on the overview: inside a list is where someone
              meets the dead composer, so the reason has to be on the same screen. */}
          <SyncBanner status={syncStatus} />
          {isNoteList ? (
            // A note is free text, not a checklist: the whole body is one editor,
            // so there is no item list, no add-item composer and no aisle UI.
            <NoteEditor rows={items} onSave={saveNote} />
          ) : (
          <>
          <div ref={listScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 80 }}>
            {items.length === 0
              ? <div style={{ textAlign: 'center', color: c.text.muted, fontSize: 15, padding: `${sp.xxxl}px ${sp.xl}px` }}>Nothing here yet. Add the first thing below.</div>
              : (() => {
                const renderRow = (it, handleProps, dragging) => (
                  <SwipeRow key={it.id} onDelete={() => swipeDeleteItem(it)} disabled={dragging}>
                    <ItemRow item={it} members={members} onToggle={toggleItem} onOpen={(item) => setSheet({ type: 'item', item })} dragHandle={handleProps} />
                  </SwipeRow>
                )
                return grouped
                  ? <AisleGroupedItems items={items} renderRow={renderRow} collapsed={collapsedSet} onToggle={toggleAisle} aisleOrder={aisleView.aisleOrder} itemOrder={aisleView.itemOrder} dragProps={dragProps} dragOver={dragOver} lifted={lifted} didDrag={didDrag} flashId={flashId} builtins={groupBuiltins} fallbackLabel={fallbackLabel} />
                  : items.map((it) => (
                    <div key={it.id} data-item-id={it.id} style={{ position: 'relative' }}>
                      {renderRow(it)}
                      <ItemFlash on={flashId === it.id} />
                    </div>
                  ))
              })()}
          </div>
          {pendingUndo ? <UndoToast onUndo={undoDelete} /> : null}
          {/* Stacking scale: section headers 1 < lifted drag rows 50 < composer 60
              < overlays 100+ (sheets/fullscreen 100, tour 105, modal 110, scanner
              120, toasts/banners 130). The composer must beat headers + lifted rows
              but stay under every overlay, so overlays live in the 100+ band. */}
          <div style={{ position: 'sticky', bottom: 0, zIndex: 60, background: c.surface.base }}>
            <ComposerBar inputRef={composer} value={draft} onChange={setDraft} onSubmit={addItem} placeholder='Add an item' disabled={!!syncTrouble(syncStatus)} />
          </div>
          </>
          )}
        </>
      ) : view === 'profile' ? (
        <ProfileView profile={profile} theme={theme} onTheme={applyTheme} autoCollapse={autoCollapse} onAutoCollapse={setAutoCollapse} onReplayTour={replayTour} onSaved={() => call('profile:get', {}).then(setProfile).catch(() => {})}
          spaceCount={spaces.length} onExport={exportBackup} onImport={importBackup} onSpacesChanged={loadSpaces}
          onLinkDevice={linkThisDevice} />
      ) : view === 'about' ? (
        <AboutView onWallet={(detected) => { setLnDetected(detected); setSheet('wallet') }} />
      ) : (
        // ===== Lists overview: all lists in the space + persistent add-list bar =====
        <>
          <TopBar
            title={<button onClick={() => setSheet('spaces')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 20, fontWeight: 400, fontFamily: FONT, maxWidth: '100%' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeSpace?.name || 'Space'}</span><CaretDown size={16} color={c.text.muted} weight='regular' /></button>}
            right={<IconButton label='Invite' onClick={() => setSheet('invite')}><ShareIcon /></IconButton>}
          />
          <MembersBar members={members} onOpen={() => setSheet('members')} />
          <SyncBanner status={syncStatus} />
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 80 }}>
            {lists.length === 0
              ? <div style={{ textAlign: 'center', color: c.text.muted, fontSize: 15, padding: `${sp.xxxl}px ${sp.xl}px` }}>No lists in {activeSpace?.name || 'this space'} yet. Add one below.</div>
              : <GroupedLists lists={lists} members={members} onOpen={setOpenListId} />}
          </div>
          {templates.length && !listDraft.trim() ? (
            <button onClick={() => setSheet('templates')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: `${sp.sm}px 0 0`, background: 'none', border: 'none', cursor: 'pointer', color: c.primary, fontSize: 14, fontWeight: 300 }}>
              Start from a saved list
            </button>
          ) : null}
          <ComposerBar inputRef={listComposer} value={listDraft} onChange={setListDraft} onSubmit={beginAddList} placeholder='Add a list' disabled={!!syncTrouble(syncStatus)} />
        </>
      )}
      {openListId === null ? <TabBar active={view === 'profile' ? 'settings' : view === 'about' ? 'about' : 'lists'} onChange={goTab} /> : null}

      <InviteSheet open={sheet === 'invite'} onClose={() => setSheet(null)} inviteKey={activeSpace?.inviteKey} spaceName={activeSpace?.name} />
      <SpaceSwitcherSheet open={sheet === 'spaces'} onClose={() => setSheet(null)} spaces={spaces} activeId={activeSpaceId}
        onPick={switchSpace} onCreate={() => setSheet('start')} onJoin={() => setSheet('join')}
        onDelete={(s) => { setDeleteTarget(s); setSheet('deleteSpace') }} onLeave={leaveSpace} />
      <StartSheet open={sheet === 'start'} onClose={() => setSheet(null)} onCreate={createSpace} />
      <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} onJoin={joinSpace} />
      <ListOptionsSheet open={sheet === 'listOptions'} list={openList} members={members} selfPubkey={selfPubkey} canReset={items.some((i) => i.checked)} onClose={() => setSheet(null)}
        grouped={grouped && presentAisles.length > 1} allCollapsed={allCollapsed} groupNoun={groupNoun}
        onToggleCollapseAll={() => { toggleCollapseAll(); setSheet(null) }}
        onRename={() => setSheet('renameList')}
        onCategory={() => setSheet('category')}
        onNotify={() => setSheet('notifyMode')}
        onAssign={() => { setSheet(null); setListPicker({ listId: openListId, current: openList?.assignee || null }) }}
        onReset={resetOpenList}
        onSaveTemplate={saveOpenListAsTemplate}
        onDelete={confirmDeleteOpenList} />
      <TemplatesSheet open={sheet === 'templates'} templates={templates} onClose={() => setSheet(null)} onUse={useTemplate} onDelete={deleteTemplate} />
      <RenameListSheet open={sheet === 'renameList'} current={openList?.name} onClose={() => setSheet(null)} onSave={renameList} />
      <CategorySheet open={sheet === 'category'} current={openList?.kind} onClose={() => setSheet(null)} onSave={(kind) => setListKind(openListId, kind)} />
      <NotifySheet open={sheet === 'notifyMode'} current={effectiveNotifyMode(openList)} onClose={() => setSheet(null)} onSave={(mode) => setNotifyMode(openListId, mode)} />
      <ListCompleteSheet open={sheet === 'listComplete'} listName={openList?.name} onClose={() => setSheet(null)} onDelete={deleteOpenList} onKeep={() => setSheet(null)} />
      <CategorySheet open={sheet === 'newListCategory'} title={`Category for "${listDraft.trim()}"`} current='list' onClose={() => setSheet(null)} onSave={createListWithKind} />
      <MembersSheet open={sheet === 'members'} onClose={() => setSheet(null)} members={members} selfPubkey={selfPubkey} spaceName={activeSpace?.name} isOwner={!!activeSpace?.owner} onRemove={removeMember} removed={removedMembers} onRestore={restoreMember} revoke={revoke} onArm={armRevocation} />
      <DeleteSpaceSheet open={sheet === 'deleteSpace'} onClose={() => { setSheet(null); setDeleteTarget(null) }} spaceName={deleteTarget?.name} onConfirm={() => deleteSpace(deleteTarget?.groupId)} />
      <LightningWalletModal open={sheet === 'wallet'} detected={lnDetected} onClose={() => setSheet(null)} />
      <DonationReminderModal open={donateReminder} onDismiss={() => setDonateReminder(false)} onDonate={() => { setDonateReminder(false); goTab('about') }} />
      <GuidedTour open={showTour} onDone={dismissTour} />
      <ConfirmHost />
      <ItemSheet
        open={!!sheet && sheet.type === 'item'} item={sheet?.item} kind={openList?.kind} noun={groupNoun} builtins={groupBuiltins} members={members} selfPubkey={selfPubkey} onClose={() => setSheet(null)}
        customAisles={isGroceryList
          ? [...new Set([...items.map((i) => i.category).filter((cat) => cat && !aisles.AISLES.includes(cat)), ...loadCustomAisles(gid)])]
          : [...new Set(items.map((i) => i.category).filter(Boolean))]}
        onSave={async (patch) => {
          await call('item:edit', { groupId: gid, listId: openListId, itemId: sheet.item.id, text: patch.text, qty: patch.qty, note: patch.note, url: patch.url })
          await call('item:assign', { groupId: gid, listId: openListId, itemId: sheet.item.id, assignee: patch.assignee })
          // Only write when it actually changed: item:setReminder rejects a past
          // time, and re-sending an untouched old reminder would fail the save for
          // no reason. Non-fatal either way - a rejected reminder must not lose
          // the text and assignee edits that already landed above.
          const prevRemind = typeof sheet.item.remindAt === 'number' ? sheet.item.remindAt : null
          if ((patch.remindAt ?? null) !== prevRemind) {
            try { await call('item:setReminder', { groupId: gid, listId: openListId, itemId: sheet.item.id, remindAt: patch.remindAt ?? null }) }
            catch (e) { alert(problem('Could not set that reminder', e)) }
          }
          if ((patch.repeat || '') !== (sheet.item.repeat || '')) {
            await call('item:setRepeat', { groupId: gid, listId: openListId, itemId: sheet.item.id, repeat: patch.repeat || null }).catch(() => {})
          }
          if (patch.catTouched) {
            const cat = patch.category || ''
            await call('ai:setCategory', { groupId: gid, listId: openListId, itemId: sheet.item.id, category: cat, by: 'user' }).catch(() => {})
            if (cat && isGroceryList) { if (!aisles.AISLES.includes(cat)) rememberCustomAisle(gid, cat); rememberOverride(patch.text || sheet.item.text, cat) }
          }
          await loadItems(gid, openListId); setSheet(null)
        }}
        onDelete={async () => { await call('item:delete', { groupId: gid, listId: openListId, itemId: sheet.item.id }); await loadItems(gid, openListId); setSheet(null) }}
      />
      <QtySheet open={!!sheet && sheet.type === 'qty'}
        onCommit={async (qty) => { const t = sheet?.text; setSheet(null); if (!t || !gid || !openListId) return; const { itemId } = await call('item:add', { groupId: gid, listId: openListId, text: t, qty }); const ov = overrideFor(t); if (itemId && ov) await call('ai:setCategory', { groupId: gid, listId: openListId, itemId, category: ov, by: 'user' }).catch(() => {}); await loadItems(gid, openListId); if (itemId) setFlashId(itemId) }}
      />
      <AssigneePickerSheet open={!!listPicker} onClose={() => setListPicker(null)} members={members} selfPubkey={selfPubkey} current={listPicker?.current}
        onPick={(pk) => { if (listPicker) assignList(listPicker.listId, pk) }} />
    </div>
  )
}

// --- sheets ---------------------------------------------------------------

function StartSheet ({ open, onClose, onCreate }) {
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  const create = () => onCreate(name.trim() || 'My space')
  return (
    <BottomSheet open={open} onClose={onClose} title='Name your space'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={name} onChange={setName} placeholder='e.g. Family, Party Crew, Roommates' autoFocus onEnter={create} />
        <Button onClick={create}>Create space</Button>
      </div>
    </BottomSheet>
  )
}

// Switch between spaces (each a separate private group), or make/join another.
// Owner gets Delete (tears the space down for everyone); everyone else gets
// Leave (retires their roster row + forgets it here). Same slot, since they are
// the two ways out and exactly one applies to you.
function SpaceSwitcherSheet ({ open, onClose, spaces, activeId, onPick, onCreate, onJoin, onDelete, onLeave }) {
  return (
    <BottomSheet open={open} onClose={onClose} title='Spaces'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: sp.base }}>
        {spaces.map((s) => {
          const active = s.groupId === activeId
          return (
            <div key={s.groupId} style={{ display: 'flex', alignItems: 'center', background: active ? c.surface.elevated : 'none', borderRadius: r.md }}>
              <button onClick={() => onPick(s.groupId)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: sp.sm, padding: `${sp.md}px ${sp.sm}px`, background: 'none', border: 'none', borderRadius: r.md, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: active ? 400 : 300, textAlign: 'left' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {active ? <Check size={18} color={c.primary} weight='bold' /> : null}
              </button>
              {s.owner ? (
                <button onClick={() => onDelete(s)} aria-label={`Delete ${s.name}`} style={{ width: 44, height: 44, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: c.text.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><TrashIcon size={17} /></button>
              ) : (
                <button onClick={() => onLeave(s)} aria-label={`Leave ${s.name}`} style={{ width: 44, height: 44, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: c.text.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><SignOut size={17} weight='regular' /></button>
              )}
            </div>
          )
        })}
      </div>
      <Button variant='secondary' onClick={onCreate}>Create a space</Button>
      <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={onJoin}>Join a space</Button>
    </BottomSheet>
  )
}

// The linked-device roster. `device:setNickname` and `device:remove` had been
// implemented since slice 2 with NO way to reach them - which is how the rename
// method came to pass its arguments in the wrong order and nobody noticed
// (see listMethods.js). Reaching them is most of what this component is for.
//
// THE TWO ACTIONS ARE NOT SYMMETRIC, and the UI reflects that rather than hiding
// it behind a uniform row:
//
//   RENAME works on THIS phone only. deviceMeta is a self-attested row - the
//   merge rule drops a put whose author is not the device it describes - so
//   "rename my partner's phone" is not a thing that can work. Offering it would
//   be a control that silently does nothing.
//
//   REMOVE works on OTHER phones only. The engine refuses to delete its own row
//   (decideDeviceMetaDel returns self:true), so a Remove on this phone would be
//   the same silent no-op in the other direction.
//
// So: the row for this phone is editable, the rows for other phones are
// removable, and neither offers the control that would not work.
function DeviceRosterSheet ({ open, onClose, devices, onRename, onRemove }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const list = devices || []
  const self = list.find((d) => d.self || d.isThisDevice) || null
  const others = list.filter((d) => !(d.self || d.isThisDevice))

  // Reset from the roster each time it opens, so a cancelled edit does not
  // survive to look like a saved one.
  useEffect(() => {
    if (open) { setName(deviceLabel(self, '')); setBusy(false) }
  }, [open, self])

  const save = async () => {
    const v = name.trim(); if (!v || v === deviceLabel(self, '')) return
    setBusy(true)
    try { await onRename(v) } catch (e) { alert(problem('Could not rename this phone', e)) }
    setBusy(false)
  }

  return (
    <BottomSheet open={open} onClose={onClose} title='Your devices'>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>
        Phones signed in as you. They share your spaces and can edit them.
      </p>

      <span style={{ color: c.text.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>This phone</span>
      <div style={{ display: 'flex', gap: sp.sm, alignItems: 'center', margin: `${sp.sm}px 0 ${sp.base}px` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Field value={name} onChange={setName} placeholder='Name this phone' />
        </div>
        <Button
          variant='secondary'
          disabled={busy || !name.trim() || name.trim() === deviceLabel(self, '')}
          style={{ width: 'auto', flexShrink: 0, opacity: busy || !name.trim() || name.trim() === deviceLabel(self, '') ? 0.5 : 1 }}
          onClick={save}
        >{busy ? 'Saving…' : 'Save'}</Button>
      </div>

      {others.length ? (
        <>
          <span style={{ color: c.text.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>Other phones</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: sp.sm }}>
            {others.map((d) => (
              <div key={d.writerKey} style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ flex: 1, minWidth: 0, padding: `${sp.md}px ${sp.sm}px`, color: c.text.primary, fontSize: 16, fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {deviceLabel(d)}
                </span>
                <button onClick={() => onRemove(d)} aria-label={`Remove ${deviceLabel(d)}`}
                  style={{ width: 44, height: 44, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: c.text.muted, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <TrashIcon size={17} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <span style={{ color: c.text.muted, fontSize: 13, fontWeight: 300 }}>No other phones yet. Pair one from the previous screen.</span>
      )}
    </BottomSheet>
  )
}

function JoinSheet ({ open, onClose, onJoin }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  useEffect(() => { if (open) { setCode(''); setBusy(false); setScanning(false) } }, [open])
  const join = async (value) => {
    const v = (value ?? code).trim(); if (!v) return
    setBusy(true)
    try { await onJoin(v) } catch (e) { setBusy(false); alert(problem('Could not join', e)) }
  }
  return (
    <>
      <BottomSheet open={open} onClose={onClose} title='Join a space'>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
          <Field value={code} onChange={setCode} placeholder='Paste the invite link' autoFocus />
          <Button disabled={busy || !code.trim()} style={{ opacity: busy || !code.trim() ? 0.5 : 1 }} onClick={() => join()}>{busy ? 'Joining…' : 'Join'}</Button>
          <Button variant='secondary' onClick={() => setScanning(true)}>Scan QR code</Button>
        </div>
      </BottomSheet>
      <ScannerView open={scanning} onClose={() => setScanning(false)} onDecode={(txt) => { setScanning(false); join(txt) }} />
    </>
  )
}

function InviteSheet ({ open, onClose, inviteKey, spaceName }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (open) setCopied(false) }, [open])
  const link = inviteUrl(inviteKey)
  const copy = async () => { try { await navigator.clipboard.writeText(link) } catch {} setCopied(true) }
  const share = () => { try { call('shell:share', { title: 'PearList invite', text: `Join ${spaceName || 'my space'} on PearList:\n\n` + link }) } catch {} }
  return (
    <BottomSheet open={open} onClose={onClose} title={`Invite to ${spaceName || 'this space'}`}>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>Anyone with this link can join {spaceName || 'this space'} and edit its lists. They will not see your other spaces. Show the QR to scan, or copy or send the link.</p>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: sp.base }}>
        {link ? <QrImage text={link} size={200} /> : null}
      </div>
      <div style={{ display: 'flex', gap: sp.sm }}>
        <Button variant='secondary' onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
        <Button onClick={share}>Share</Button>
      </div>
    </BottomSheet>
  )
}

// The pair link, shown on the phone you ALREADY use. Deliberately not styled like
// InviteSheet even though the mechanics rhyme: a space invite is safe to forward
// to a housemate, and this is the opposite - whoever holds it becomes you. The
// warning is the first thing in the sheet, and there is no Share button, because
// "send this to someone" is exactly the wrong instinct here.
function PairLinkSheet ({ open, url, onClose }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (open) setCopied(false) }, [open])
  const copy = async () => { try { await navigator.clipboard.writeText(url) } catch {} setCopied(true) }
  return (
    <BottomSheet open={open} onClose={onClose} title='Pair a device'>
      <p style={{ color: c.warn, fontSize: 14, fontWeight: 400, textAlign: 'center', margin: `0 0 ${sp.sm}px` }}>
        Only for a phone you own.
      </p>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>
        This link hands over your identity - anyone who uses it becomes you, in every space you are in. Scan it on your other phone, or copy it across. It expires shortly.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: sp.base }}>
        {url ? <QrImage text={url} size={200} /> : null}
      </div>
      <Button variant='secondary' onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
    </BottomSheet>
  )
}

// The RECEIVING half of pairing, on the phone being added. Replaces a raw
// window.prompt() that rendered as a system dialog titled "JavaScript" asking the
// user to paste a link which hands over their identity - which is what a phishing
// screen looks like. Found by driving the flow on hardware, 2026-07-29.
//
// Shaped like JoinSheet (paste field, then scan) because the mechanics are the
// same and a second pattern for "put a link in" would be gratuitous. Worded like
// PairLinkSheet, because the stakes are not the same: joining a space gets you
// into ONE space that someone chose to share, and this makes this phone BECOME
// you, everywhere. The warning is the first thing in the sheet for that reason.
//
// Scan is offered before paste in the copy but rendered after the field, matching
// JoinSheet's order so the two screens do not feel arbitrarily different.
function LinkDeviceSheet ({ open, onClose, onLink }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => { if (open) { setUrl(''); setBusy(false); setScanning(false); setError(null) } }, [open])

  const link = async (value) => {
    const v = (value ?? url).trim(); if (!v) return
    setBusy(true); setError(null)
    // Errors render INSIDE the sheet, not through alert(). An Android WebView
    // titles alert() "JavaScript" exactly as it does prompt(), so routing the
    // failure through it would reintroduce the thing this screen exists to fix -
    // caught on hardware 2026-07-29 after the prompt was already gone.
    // Inline is also simply better here: the message names what to do next, and
    // it belongs next to the field the user has to correct.
    //
    // onLink owns the wording: it is the only thing that knows whether this was
    // the wrong kind of link, an expired one, or a pairing that never completed.
    try { await onLink(v) } catch (e) { setBusy(false); setError(terminated(e.message || String(e))) }
  }

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title='Link this phone'>
        <p style={{ color: c.warn, fontSize: 14, fontWeight: 400, textAlign: 'center', margin: `0 0 ${sp.sm}px` }}>
          Only use a link from your own phone.
        </p>
        <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>
          This phone will become you - it gets your spaces and can edit them. Open Settings on the phone you already use, tap Pair, and scan or paste what it shows.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
          <Field value={url} onChange={(v) => { setUrl(v); if (error) setError(null) }} placeholder='Paste the pairing link' autoFocus />
          {error ? <span role='alert' style={{ color: c.warn, fontSize: 13, fontWeight: 300, lineHeight: 1.45 }}>{error}</span> : null}
          <Button disabled={busy || !url.trim()} style={{ opacity: busy || !url.trim() ? 0.5 : 1 }} onClick={() => link()}>{busy ? 'Linking…' : 'Link this phone'}</Button>
          <Button variant='secondary' onClick={() => setScanning(true)}>Scan QR code</Button>
        </div>
      </BottomSheet>
      <ScannerView open={scanning} onClose={() => setScanning(false)} onDecode={(txt) => { setScanning(false); link(txt) }} />
    </>
  )
}

// A list row on the space overview. Tapping opens the list's detail.
function ListRow ({ list, members, onOpen }) {
  const cat = categoryOf(list.kind)
  const Icon = cat.Icon
  return (
    <button onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.base}px`, background: 'none', border: 'none', borderBottom: `1px solid ${c.divider}`, cursor: 'pointer', textAlign: 'left' }}>
      <Icon size={20} color={cat.color} weight='regular' />
      <span style={{ flex: 1, minWidth: 0, color: c.text.primary, fontSize: 17, fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
      <AssigneeAvatar pubkey={list.assignee} members={members} size={24} />
      <CaretRight size={18} color={c.text.muted} weight='regular' />
    </button>
  )
}

// The Lists overview, grouped into category sections (Shopping, Chores, ...)
// in CATEGORIES order. Section headers only show once more than one category is
// in use, so a space that never categorizes still reads as one flat list.
function GroupedLists ({ lists, members, onOpen }) {
  const groups = CATEGORIES
    .map((cat) => ({ cat, items: lists.filter((l) => categoryOf(l.kind).key === cat.key) }))
    .filter((g) => g.items.length > 0)
  const showHeaders = groups.length > 1
  return (
    <>
      {groups.map(({ cat, items }) => (
        <div key={cat.key}>
          {showHeaders ? <SectionHeader cat={cat} count={items.length} /> : null}
          {items.map((l) => <ListRow key={l.id} list={l} members={members} onOpen={() => onOpen(l.id)} />)}
        </div>
      ))}
    </>
  )
}

function SectionHeader ({ cat, count }) {
  const Icon = cat.Icon
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `${sp.md}px ${sp.base}px ${sp.xs}px` }}>
      <Icon size={15} color={cat.color} weight='regular' />
      <span style={{ flex: 1, color: c.text.secondary, fontSize: 12, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.6 }}>{cat.section}</span>
      <span style={{ color: c.text.muted, fontSize: 12 }}>{count}</span>
    </div>
  )
}

// A note list's body: one plain textarea over the note's line rows.
//
// The rows are the source of truth and the textarea is a VIEW of them, so the
// two have to be reconciled carefully:
//
//   - While the user has unsaved typing (`dirty`) or a save is in flight, an
//     incoming `rows` prop must NOT re-hydrate the textarea. Otherwise a peer's
//     sync, or the ordinary refresh poll, yanks the cursor mid-sentence.
//   - A save sends the rows as we LOADED them (`baseline`) plus the current
//     lines, and note:save derives the edit from that pair. So a line a peer
//     added while we typed is untouched: it is not in our baseline, so nothing
//     in the plan refers to it. See planNoteSave in noteText.js.
//   - After a save we adopt the freshly stored rows as the new baseline, and
//     only re-render the textarea from them if the user has stopped typing -
//     which is also how a peer's edit finally becomes visible.
//
// Saves are debounced on idle and flushed on blur and on unmount, so leaving the
// note by any route (back, tab, space switch) commits it.
const NOTE_SAVE_DEBOUNCE_MS = 800
function NoteEditor ({ rows, onSave }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const textRef = useRef('')
  const baseRef = useRef([])
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const timerRef = useRef(null)
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const adopt = useCallback((fresh, retext) => {
    baseRef.current = sortNoteRows(fresh || []).map((r) => ({ id: r.id, text: String(r.text || '') }))
    if (!retext) return
    const next = joinLines(baseRef.current.map((b) => b.text))
    textRef.current = next
    setText(next)
  }, [])

  // Hydrate from the store, but only when there is nothing local to lose.
  useEffect(() => {
    if (dirtyRef.current || savingRef.current) return
    adopt(rows, true)
  }, [rows, adopt])

  const flush = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (!dirtyRef.current) return
    // A save is already in flight. Do NOT just drop this one: the keystrokes that
    // triggered it would then sit unsaved until the next keystroke or a blur. Come
    // back for them instead.
    if (savingRef.current) { timerRef.current = setTimeout(() => flushRef.current(), NOTE_SAVE_DEBOUNCE_MS); return }
    const sent = textRef.current
    savingRef.current = true
    if (aliveRef.current) setSaving(true)
    try {
      const fresh = await onSave(baseRef.current, splitLines(sent))
      // Clear the dirty flag only if nothing was typed while we were saving;
      // otherwise the next debounce picks the remainder up.
      const stillCurrent = textRef.current === sent
      if (stillCurrent) dirtyRef.current = false
      if (aliveRef.current) adopt(fresh, stillCurrent)
      else baseRef.current = []
    } catch {
      // Keep the text and stay dirty, so the next flush retries.
    } finally {
      savingRef.current = false
      if (aliveRef.current) setSaving(false)
    }
  }, [onSave, adopt])

  // Always flush the LATEST closure on unmount, without re-running the effect
  // (and firing a save) every time flush is rebuilt.
  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush })
  useEffect(() => () => { flushRef.current() }, [])

  // Also flush when the app goes to the background. An unmount flush is not
  // enough: the GrapheneOS freeze recovery TERMINATES the WebView's render
  // process on resume (see modules/webview-recovery), and a killed process does
  // not unmount anything - so a debounce still pending when the user backgrounds
  // mid-sentence would die with it. visibilitychange fires while the page is
  // still alive, which is the last safe moment to commit.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  const onChange = (v) => {
    textRef.current = v
    dirtyRef.current = true
    setText(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => flushRef.current(), NOTE_SAVE_DEBOUNCE_MS)
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => flushRef.current()}
        placeholder='Write anything here. It syncs to everyone in the space.'
        spellCheck
        style={{
          flex: 1, minHeight: 0, width: '100%', resize: 'none', border: 'none', outline: 'none',
          background: c.surface.base, color: c.text.primary, fontFamily: FONT, fontSize: 16,
          fontWeight: 300, lineHeight: 1.6,
          padding: `${sp.base}px ${sp.base}px calc(var(--pear-safe-bottom) + ${sp.xxl}px)`,
        }}
      />
      {saving ? (
        <span style={{ position: 'absolute', right: sp.base, bottom: `calc(var(--pear-safe-bottom) + ${sp.sm}px)`, color: c.text.muted, fontSize: 12, fontWeight: 300, pointerEvents: 'none' }}>Saving…</span>
      ) : null}
    </div>
  )
}

// Tap-to-add chips of previously-added items, shown above the add-item bar. The
// bottom padding keeps a little buffer above the composer's divider line.
function SuggestionBar ({ items, onPick }) {
  return (
    <div style={{ display: 'flex', gap: sp.sm, overflowX: 'auto', padding: `${sp.sm}px ${sp.base}px ${sp.md}px`, WebkitOverflowScrolling: 'touch' }}>
      {items.map((t) => (
        <button key={t} onClick={() => onPick(t)} style={{ flexShrink: 0, padding: '7px 14px', borderRadius: r.full, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.secondary, fontSize: 14, fontWeight: 300, cursor: 'pointer', whiteSpace: 'nowrap' }}>{t}</button>
      ))}
    </div>
  )
}

// Sticky bottom input + add button, reused for the add-list (overview) and
// add-item (list detail) bars.
// `disabled` is the write block for a space this device cannot write to (see
// SyncBanner, which is on screen saying why whenever this is set). Typing a
// shopping list into a space that will never send it is worse than being stopped:
// the entry is lost with no error, which is precisely how the 2026-07-28 report
// read from the user's side.
function ComposerBar ({ value, onChange, onSubmit, placeholder, inputRef, disabled }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, display: 'flex', gap: sp.sm, padding: `${sp.sm}px ${sp.base}px calc(var(--pear-safe-bottom) + ${sp.sm}px)`, background: c.surface.base }}>
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) onSubmit() }} placeholder={placeholder} disabled={!!disabled} style={{ flex: 1, padding: '12px 14px', background: c.surface.input, color: disabled ? c.text.muted : c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none' }} />
      <button onClick={onSubmit} disabled={!!disabled} aria-label='Add' style={{ width: 46, borderRadius: r.md, border: 'none', background: disabled ? c.surface.input : c.primary, color: disabled ? c.text.muted : c.text.onPrimary, cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={22} weight='bold' /></button>
    </div>
  )
}

// List-detail header: back to the overview, list name, and a list-options button.
function DetailHeader ({ title, assignee, members, onBack, onOptions }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `calc(var(--pear-safe-top) + ${sp.md}px) ${sp.base}px ${sp.md}px`, borderBottom: `1px solid ${c.border}`, background: c.surface.base, position: 'sticky', top: 0, zIndex: 5 }}>
      <button onClick={onBack} aria-label='Back to lists' style={{ width: 36, height: 36, background: 'none', border: 'none', color: c.text.secondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CaretLeft size={24} weight='regular' /></button>
      <h1 style={{ flex: 1, textAlign: 'center', fontSize: 20, fontWeight: 400, margin: 0, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
      <span style={{ display: 'flex', alignItems: 'center', gap: sp.xs }}>
        <AssigneeAvatar pubkey={assignee} members={members} size={22} />
        <IconButton label='List options' onClick={onOptions}><DotsThree size={22} weight='bold' /></IconButton>
      </span>
    </header>
  )
}

// List options (rename / category / notify / assign / delete), opened from the
// detail header. The completion-notify row shows only on chore lists.
//
// Row copy stays GENERIC ("Rename", "Delete"), because this sheet also opens on
// a note, which is not a list. ListCompleteSheet still says "Delete list" and
// should: it only ever fires when every item on a list is checked, and a note's
// lines are never checked, so a note cannot reach it.
function ListOptionsSheet ({ open, list, members, selfPubkey, canReset, grouped, allCollapsed, groupNoun = 'aisle', onToggleCollapseAll, onClose, onRename, onCategory, onNotify, onAssign, onReset, onSaveTemplate, onDelete }) {
  if (!list) return null
  const Row = ({ onClick, danger, children }) => (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: danger ? c.error : c.text.primary, fontSize: 16, fontWeight: 300 }}>{children}</button>
  )
  const cat = categoryOf(list.kind)
  const CatIcon = cat.Icon
  // Chore lists are a parent/child setup: only the creator (owner) may delete
  // one, so a child cannot remove a parent-managed list. Other kinds keep the
  // egalitarian model (anyone may delete). Falls open if createdBy is missing.
  const canDelete = list.kind !== 'chore' || !list.createdBy || list.createdBy === selfPubkey
  return (
    <BottomSheet open={open} onClose={onClose} title={list.name}>
      <Row onClick={onRename}><span style={{ flex: 1, textAlign: 'left' }}>Rename</span></Row>
      <Row onClick={onCategory}><span style={{ flex: 1, textAlign: 'left' }}>Category</span><CatIcon size={18} color={cat.color} weight='regular' /><span style={{ color: c.text.secondary, fontSize: 14 }}>{cat.label}</span></Row>
      <Row onClick={onAssign}><span style={{ flex: 1, textAlign: 'left' }}>Assign to…</span><AssigneeAvatar pubkey={list.assignee} members={members} size={22} /></Row>
      {list.kind === 'chore' ? <Row onClick={onNotify}><span style={{ flex: 1, textAlign: 'left' }}>Notify when completed</span><span style={{ color: c.text.secondary, fontSize: 14 }}>{notifyModeOf(effectiveNotifyMode(list)).label}</span></Row> : null}
      {grouped ? <Row onClick={onToggleCollapseAll}><span style={{ flex: 1, textAlign: 'left' }}>{allCollapsed ? `Expand all ${groupNoun}s` : `Collapse all ${groupNoun}s`}</span></Row> : null}
      {canReset ? <Row onClick={onReset}><span style={{ flex: 1, textAlign: 'left' }}>Uncheck all</span></Row> : null}
      <Row onClick={onSaveTemplate}><span style={{ flex: 1, textAlign: 'left' }}>Save as template</span><span style={{ color: c.text.muted, fontSize: 13 }}>this phone</span></Row>
      {canDelete ? <Row onClick={onDelete} danger><span style={{ flex: 1, textAlign: 'left' }}>Delete</span></Row> : null}
    </BottomSheet>
  )
}

// Saved lists ("templates"), kept on this phone only. Tapping one creates a NEW
// list in the current space from its items; the trash forgets it here and touches
// nothing anyone else can see. The copy leans on that distinction, because "saved
// on this phone" is exactly the thing a household app makes people guess about.
function TemplatesSheet ({ open, templates, onClose, onUse, onDelete }) {
  return (
    <BottomSheet open={open} onClose={onClose} title='Saved lists'>
      <p style={{ color: c.text.muted, fontSize: 13, textAlign: 'center', lineHeight: 1.45, margin: `0 0 ${sp.sm}px` }}>
        Saved on this phone only. Starting one creates a new list that everyone in the space can see.
      </p>
      {templates.length === 0 ? (
        <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', lineHeight: 1.5, margin: `${sp.md}px 0` }}>
          Nothing saved yet. Open a list, tap its options and choose "Save as template".
        </p>
      ) : templates.map((t) => {
        const cat = categoryOf(t.kind)
        const CatIcon = cat.Icon
        return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', borderTop: `1px solid ${c.divider}` }}>
            <button onClick={() => onUse(t)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }}>
              <CatIcon size={18} color={cat.color} weight='regular' />
              <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              <span style={{ color: c.text.muted, fontSize: 13, flexShrink: 0 }}>{t.count} item{t.count === 1 ? '' : 's'}</span>
            </button>
            <button onClick={() => onDelete(t)} aria-label={`Forget ${t.name}`} style={{ width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: c.text.muted }}>
              <Trash size={18} weight='regular' />
            </button>
          </div>
        )
      })}
    </BottomSheet>
  )
}

// Pick a chore list's completion-notify mode. The list's creator/owner is the
// notify target (not the assignee), so we say so.
function NotifySheet ({ open, current, onClose, onSave }) {
  return (
    <BottomSheet open={open} onClose={onClose} title='Notify when completed'>
      <p style={{ color: c.text.muted, fontSize: 13, textAlign: 'center', margin: `0 0 ${sp.sm}px` }}>Sent to whoever created this list.</p>
      {NOTIFY_MODES.map((m) => {
        const on = m.key === current
        return (
          <button key={m.key} onClick={() => onSave(m.key)} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: on ? 400 : 300 }}>
            <span style={{ flex: 1, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{m.label}</span>
              <span style={{ color: c.text.muted, fontSize: 13, fontWeight: 300 }}>{m.hint}</span>
            </span>
            {on ? <Check size={18} color={c.primary} weight='bold' /> : null}
          </button>
        )
      })}
    </BottomSheet>
  )
}

// Pick a list's category. Reuses the bottom-sheet pattern; the current kind is
// checked. Used both to change an existing list's category (onSave -> setKind)
// and as the create-time prompt (onSave -> create with the chosen kind).
function CategorySheet ({ open, current, title = 'Category', onClose, onSave }) {
  const cur = categoryOf(current).key
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {CATEGORIES.map((cat) => {
        const Icon = cat.Icon
        const on = cat.key === cur
        return (
          <button key={cat.key} onClick={() => onSave(cat.key)} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: on ? 400 : 300 }}>
            <Icon size={20} color={cat.color} weight='regular' />
            <span style={{ flex: 1, textAlign: 'left' }}>{cat.label}</span>
            {on ? <Check size={18} color={c.primary} weight='bold' /> : null}
          </button>
        )
      })}
    </BottomSheet>
  )
}

// Rename copy stays GENERIC ("Rename", not "Rename list"). The sheet is opened
// from a list of any kind, including a note, which is not a list at all.
function RenameListSheet ({ open, current, onClose, onSave }) {
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName(current || '') }, [open, current])
  return (
    <BottomSheet open={open} onClose={onClose} title='Rename'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={name} onChange={setName} autoFocus onEnter={() => name.trim() && onSave(name.trim())} />
        <Button onClick={() => name.trim() && onSave(name.trim())}>Save</Button>
      </div>
    </BottomSheet>
  )
}

// Transient toast (e.g. "Alex joined", "Space deleted"). Tap to dismiss.
function Banner ({ text, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 'calc(var(--pear-safe-top) + 8px)', left: '50%', transform: 'translateX(-50%)', zIndex: 130, maxWidth: 560, width: 'calc(100% - 24px)', background: c.primary, color: c.text.onPrimary, padding: '10px 16px', borderRadius: r.lg, fontSize: 14, fontWeight: 400, textAlign: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', cursor: 'pointer' }}>{text}</div>
  )
}

// Who's in the space.
// The space's roster. The OWNER (and only the owner) can remove a member here:
// the stale-device case, where a wiped or replaced phone would otherwise sit in
// the roster forever with no way out. Removal hides them and is reversible with
// a fresh invite; it does not revoke a device that still holds the space, which
// is why the copy says "remove", never "block".
function MembersSheet ({ open, onClose, members, selfPubkey, spaceName, isOwner, onRemove, removed = [], onRestore, revoke, onArm }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={`In ${spaceName || 'this space'}`}>
      {members.length === 0
        ? <p style={{ color: c.text.muted, fontSize: 14, textAlign: 'center', padding: `${sp.base}px 0` }}>Just you so far.</p>
        : members.map((m) => {
            const isSelf = m.pubkey === selfPubkey
            return (
              <div key={m.pubkey} style={{ display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.xs}px`, borderTop: `1px solid ${c.divider}` }}>
                <Avatar name={m.displayName} avatar={m.avatar} size={40} />
                <span style={{ flex: 1, minWidth: 0, color: c.text.primary, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.displayName || 'Member'}{isSelf ? ' (You)' : ''}</span>
                {isOwner && !isSelf ? (
                  <button onClick={() => onRemove(m)} aria-label={`Remove ${m.displayName || 'member'}`} style={{ width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: c.text.muted }}><UserMinus size={20} weight='regular' /></button>
                ) : null}
              </div>
            )
          })}

      {/* Removed members, owner only. Restore MUST live here: an evicted pubkey stays
          evicted even if that device rejoins with a fresh invite (only the owner can
          write the `space` row), so without this the removal is one-way in practice. */}
      {isOwner && removed.length ? (
        <>
          <div style={{ color: c.text.secondary, fontSize: 12, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.6, padding: `${sp.lg}px ${sp.xs}px ${sp.xs}px` }}>Removed</div>
          {removed.map((m) => (
            <div key={m.pubkey} style={{ display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.xs}px`, borderTop: `1px solid ${c.divider}`, opacity: 0.65 }}>
              <Avatar name={m.displayName} avatar={m.avatar} size={40} />
              <span style={{ flex: 1, minWidth: 0, color: c.text.secondary, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.displayName || 'Member'}</span>
              <button onClick={() => onRestore(m)} style={{ flexShrink: 0, padding: '8px 14px', borderRadius: r.md, border: `1px solid ${c.text.muted}`, background: 'transparent', color: c.text.primary, fontSize: 14, cursor: 'pointer' }}>Add back</button>
            </div>
          ))}
        </>
      ) : null}

      {/* Stronger removal (hard writer revocation), owner only. Off until EVERY member
          has updated: a peer that does not understand it would keep accepting a removed
          device's changes and silently drift out of sync with everyone else. */}
      {isOwner && revoke && !revoke.armed ? (
        <div style={{ marginTop: sp.lg, paddingTop: sp.base, borderTop: `1px solid ${c.divider}` }}>
          <div style={{ color: c.text.primary, fontSize: 15, marginBottom: 4 }}>Stronger removal</div>
          <p style={{ color: c.text.muted, fontSize: 13, fontWeight: 300, lineHeight: 1.45, margin: `0 0 ${sp.base}px` }}>
            {revoke.canArm
              ? 'Removed devices also lose the ability to change anything here, not just disappear from the list. They can still see what they already have.'
              : `Everyone has to update first (${revoke.ready} of ${revoke.total} done${revoke.waitingOn?.length ? `, waiting on ${revoke.waitingOn.join(', ')}` : ''}).`}
          </p>
          <Button variant='secondary' disabled={!revoke.canArm} style={{ opacity: revoke.canArm ? 1 : 0.5 }} onClick={onArm}>Turn on</Button>
        </div>
      ) : null}
    </BottomSheet>
  )
}

function DeleteSpaceSheet ({ open, onClose, spaceName, onConfirm }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={`Delete ${spaceName || 'space'}?`}>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', lineHeight: 1.5, margin: `0 0 ${sp.lg}px` }}>This deletes the space and all its lists for everyone in it. This cannot be undone.</p>
      <Button variant='danger' onClick={onConfirm}>Delete for everyone</Button>
      <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={onClose}>Cancel</Button>
    </BottomSheet>
  )
}

// Offered when checking the last open item completes a list: delete it, or keep
// it. Deleting removes the list for everyone in the space (a shared tombstone).
function ListCompleteSheet ({ open, listName, onDelete, onKeep, onClose }) {
  return (
    <BottomSheet open={open} onClose={onClose} title='All done 🎉'>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', lineHeight: 1.5, margin: `0 0 ${sp.lg}px` }}>Every item on {listName ? `"${listName}"` : 'this list'} is checked off. Delete the list? This removes it for everyone in the space.</p>
      <Button variant='danger' onClick={onDelete}>Delete list</Button>
      <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={onKeep}>Keep it</Button>
    </BottomSheet>
  )
}


// One plain line under the "Connect Anywhere" row saying whether the relay has
// actually been needed. The counters reset when the app restarts, and they only
// climb on the phone that ACCEPTED a relayed connection, so "none so far" on one
// device is not proof that neither device relayed. See relay:stats.
function relaySummary (s, on) {
  if (!on) return 'Off. Your phones will sync only when they can reach each other directly.'
  const { successes = 0, attempts = 0 } = s.relaying || {}
  if (successes > 0) return `Used for ${successes} connection${successes > 1 ? 's' : ''} since PearList started.`
  if (attempts > 0) return `Tried ${attempts} time${attempts > 1 ? 's' : ''} since PearList started, without completing.`
  return 'On. Not needed so far, every connection has been direct.'
}

// MODULE SCOPE ON PURPOSE. These were defined inside ProfileView, which gave them
// a new component identity on every render - so React unmounted and rebuilt the
// entire settings subtree each time, destroying and recreating every DOM node in
// it. Harmless for text and toggles, fatal for a control that owns native UI: the
// reminder's <input type='time'> had its element replaced out from under the open
// Android time picker, which dismissed the picker before a time could be chosen.
// ProfileView re-renders every 5s (the relay:stats poll), so the picker never
// survived longer than that.
//
// alignTop pins the control to the TITLE's line instead of centring it over the
// whole row. Use it when `extra` is an interactive control of its own (the
// reminder's time picker): centred, the toggle floats between the two lines and
// reads as if it belongs to the picker rather than to the setting.
function Setting ({ title, about, aboutLink, control, extra, first, alignTop, onAbout }) {
  return (
    <div style={{ display: 'flex', alignItems: alignTop ? 'flex-start' : 'center', justifyContent: 'space-between', gap: sp.base, padding: `${sp.md}px 0`, borderTop: first ? 'none' : `1px solid ${c.divider}` }}>
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: sp.sm, minHeight: 28 }}>
          <span style={{ color: c.text.primary, fontSize: 16, fontWeight: 300 }}>{title}</span>
          {about ? <button onClick={() => onAbout?.({ title, body: about, link: aboutLink })} aria-label={`About ${title}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: c.text.muted }}><Info size={16} weight='regular' /></button> : null}
        </span>
        {extra}
      </span>
      {/* Matches the title line's minHeight so the control centres against the
          title, not against the top edge of the row. */}
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, ...(alignTop ? { minHeight: 28 } : {}) }}>{control}</span>
    </div>
  )
}
function Group ({ title, children }) {
  return (
    <div style={{ marginBottom: sp.lg }}>
      <div style={{ color: c.text.secondary, fontSize: 12, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.6, padding: `0 ${sp.xs}px ${sp.xs}px` }}>{title}</div>
      <div style={{ background: c.surface.elevated, borderRadius: r.lg, padding: `${sp.xs}px ${sp.base}px` }}>{children}</div>
    </div>
  )
}

function ProfileView ({ profile, theme, onTheme, autoCollapse, onAutoCollapse, onReplayTour, onSaved, spaceCount, onExport, onImport, onSpacesChanged, onLinkDevice }) {
  // Linked devices (slice 2 of proposals/2026-07-28-device-linking.md). The whole
  // group is hidden unless the worklet says device-link is enabled, so an ordinary
  // build shows nothing new.
  const [dl, setDl] = useState(null)          // { enabled, devices, ... } | null
  const [pairUrl, setPairUrl] = useState(null)
  const [linking, setLinking] = useState(false)
  const [roster, setRoster] = useState(false)
  const loadDevices = useCallback(async () => {
    const st = await call('device:status', {}).catch(() => null)
    setDl(st)
  }, [])
  useEffect(() => { loadDevices() }, [loadDevices])
  async function pairDevice () {
    try {
      const { url } = await call('device:startPairing', {})
      setPairUrl(url)
    } catch (e) { alert(problem('Could not start pairing', e)) }
  }
  // The link itself is handled at the app level (onLinkDevice), because
  // onboarding needs the same path and only the app knows where to land the user
  // afterwards. All this adds is refreshing the roster on THIS screen, which is
  // the only thing Settings owns that the pairing changes.
  //
  // Throws on purpose: LinkDeviceSheet catches and shows the message, so the
  // error surfaces on the sheet the user is looking at rather than behind it.
  async function linkThisDevice (url) {
    await onLinkDevice(url)
    await loadDevices()
    // Pairing SEEDS the other phone's spaces onto this one, so the spaces list is
    // stale the moment this returns - same reason removeDevice re-reads it.
    await onSpacesChanged?.()
    setLinking(false)
  }

  // Renames THIS phone. No writerKey: deviceMeta is self-attested, so a device
  // can only name itself - see device:setNickname in listMethods.js.
  //
  // AND IT CAN LEGITIMATELY FAIL, which it used to do in silence. If this phone has
  // been removed from the account on another device, its writer key is revoked and
  // the rename is refused - correctly. But the sheet closed as though it had saved,
  // which is how it looked on hardware 2026-07-29: type a name, tap Save, nothing
  // happens, no reason given. Say what happened instead.
  async function renameThisDevice (nickname) {
    const res = await call('device:setNickname', { nickname }).catch(() => null)
    await loadDevices()
    if (res && !res.ok) {
      alert(res.writable === false
        ? 'This phone was removed from your account on another phone, so it can no longer change it. Link it again to use it as yours.'
        : 'Could not save that name. Try again in a moment.')
    }
  }

  // Takes another phone off the roster AND revokes its writer key on the personal
  // base. The confirm still has to be honest about the part that has NOT changed:
  // the removed phone keeps the recovery phrase, keeps the shared spaces, and can
  // still edit those. Saying otherwise would reassure someone about a lost phone
  // that is still able to change the household's lists.
  //
  // This can also be REFUSED, and used to be refused in silence: a phone that has
  // itself been removed cannot write to the personal base, so it cannot remove
  // anything either. Correct, but it needs saying.
  async function removeDevice (d) {
    const label = deviceLabel(d)
    const ok = await askConfirm({
      title: `Remove ${label}?`,
      // Precise on purpose, and it changed when the personal-base revocation
      // landed. It is now MORE than "hides a row" and still LESS than a lockout,
      // and the middle is the honest place: it can no longer write to your own
      // account, it CAN still edit shared lists, and it still holds the phrase.
      // Rounding either way is the failure mode - a lost phone is the one case
      // where a person acts on this sentence.
      message: `It stops showing in this list and can no longer change your own account. It does NOT lock that phone out of your shared lists - it still has your recovery phrase and your spaces, and can still edit them. To take it off those for real you would need to move them to a new space.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    let res
    try { res = await call('device:remove', { writerKey: d.writerKey }) } catch (e) { alert(problem('Could not remove that phone', e)); return }
    await loadDevices()
    // AND RE-READ THE SPACES, because removal can change who OWNS one: if the phone
    // being removed owned a space, this device takes it over first (see
    // revokeDeviceFromSpaces). `spaces:list` computes each space's `owner` flag from
    // the applied view, and the Spaces sheet swaps its trash/leave icon on it - so
    // without this the row keeps offering "leave" a space this phone now owns.
    // Cost real confusion during the 2026-07-29 hardware run: the stale icon read
    // exactly like the ownership transfer having been rejected when it had applied.
    await onSpacesChanged?.()
    if (res && res.ok === false) {
      alert(res.self
        ? 'That is this phone. To sign this phone out, remove it from one of your other phones.'
        : 'This phone was removed from your account on another phone, so it can no longer change it.')
      return
    }
    // Say how far the shared-list part actually got. Removal is best-effort per
    // space - a space no one has finished updating cannot honour it yet - and
    // reporting a clean sweep when three of four worked is the kind of wrong that
    // matters most on a lost phone.
    const sp = res && res.spaces
    if (sp && (sp.revoked || (sp.blocked && sp.blocked.length))) {
      const blocked = (sp.blocked || []).length
      if (!blocked) {
        alert(`Done. That phone can no longer edit your shared lists${sp.revoked > 1 ? ` (${sp.revoked} spaces)` : ''}.`)
      } else if ((sp.blocked || []).some((b) => b.why === 'owner-transfer-failed')) {
        // Distinct message: the reason is not "update everyone", and sending someone
        // to fix that would waste their time on the wrong thing.
        alert('That phone still runs one or more of your spaces and this phone could not take them over, so it keeps access to those - cutting it off would leave nobody able to manage them. Try again in a moment.')
      } else if (!sp.revoked) {
        alert('That phone is off your account, but it can still edit your shared lists. Everyone in a space has to be on the latest version before it can be cut off there.')
      } else {
        alert(`That phone was cut off from ${sp.revoked} of ${sp.revoked + blocked} spaces. In the rest, everyone has to be on the latest version first.`)
      }
    }
  }
  const fileRef = useRef(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notif, setNotif] = useState(false)
  const [bgSync, setBgSync] = useState(false)
  const [bgSyncSupported, setBgSyncSupported] = useState(false)
  useEffect(() => { setName(profile?.displayName || '') }, [profile])
  useEffect(() => { call('shell:notifications:get', {}).then((r) => setNotif(!!r?.enabled)).catch(() => {}) }, [])
  useEffect(() => { call('shell:bgsync:get', {}).then((r) => { setBgSyncSupported(!!r?.supported); setBgSync(!!r?.enabled) }).catch(() => {}) }, [])
  async function toggleNotif (v) {
    try {
      const r = await call('shell:notifications:set', { enabled: v })
      setNotif(!!r?.enabled)
      if (v && r?.permissionDenied) alert('Turn on notifications for PearList in your device Settings to receive alerts.')
    } catch { setNotif(false) }
  }
  async function toggleBgSync (v) {
    try { const r = await call('shell:bgsync:set', { enabled: v }); setBgSync(!!r?.enabled) } catch { setBgSync(false) }
  }
  // Daily reminder: a once-a-day nudge about lists with open items. Off by
  // default. The time is stored as hour + minute and edited through
  // TimeOfDaySheet - ours, not the OS one, so it matches the item picker and
  // looks the same on both platforms.
  const [reminder, setReminder] = useState({ enabled: false, hour: 18, minute: 0 })
  useEffect(() => { call('shell:reminder:get', {}).then((r) => { if (r) setReminder({ enabled: !!r.enabled, hour: r.hour ?? 18, minute: r.minute ?? 0 }) }).catch(() => {}) }, [])
  async function saveReminder (next) {
    setReminder(next) // optimistic: the toggle should not lag the tap
    try {
      const r = await call('shell:reminder:set', next)
      if (r) setReminder({ enabled: !!r.enabled, hour: r.hour ?? next.hour, minute: r.minute ?? next.minute })
      if (next.enabled && r && r.notificationsEnabled === false) {
        alert('Turn on notifications for PearList in your device Settings to get the daily reminder.')
      }
    } catch { setReminder((p) => ({ ...p, enabled: false })) }
  }
  const [pickTime, setPickTime] = useState(false)
  // Rendered for a person, not stored: the picker owns hour + minute. The old
  // native <input type='time'> displayed a 24h value in local format, which is
  // why "18:00" looked like "6:00 PM" and hid the fact this was still the OS one.
  const reminderTime = new Date(2026, 0, 1, reminder.hour, reminder.minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  // "Connect Anywhere" - the off-LAN relay backstop. Default on, so an unanswered
  // read shows on rather than flickering off and back.
  const [relayOn, setRelayOn] = useState(true)
  useEffect(() => { call('relay:get', {}).then((r) => setRelayOn(r?.useRelay !== false)).catch(() => {}) }, [])
  async function toggleRelay (v) {
    try { const r = await call('relay:set', { on: v }); setRelayOn(r?.useRelay !== false) } catch {}
  }
  // Whether the relay has actually carried anything. Without this a relayed
  // connection is indistinguishable from a direct one, which makes the off-LAN
  // behaviour untestable in the field. Polled while Settings is open.
  const [relayStats, setRelayStats] = useState(null)
  useEffect(() => {
    let live = true
    const poll = () => call('relay:stats', {}).then((r) => { if (live) setRelayStats(r) }).catch(() => {})
    poll()
    const t = setInterval(poll, 5000)
    return () => { live = false; clearInterval(t) }
  }, [])
  const [learned, setLearned] = useState(0)
  useEffect(() => { setLearned(overrideCount()) }, [])
  async function clearLearned () {
    if (!learned) return
    const ok = await askConfirm({ title: 'Clear learned aisles?', message: `Forget ${learned} learned aisle${learned > 1 ? 's' : ''}? New items will be sorted automatically again.`, confirmLabel: 'Clear', danger: true })
    if (!ok) return
    clearOverrides(); setLearned(0)
  }

  // Longer explanations, shown in a modal from each row's info dot (kept out of
  // the row so the settings list stays scannable).
  const [info, setInfo] = useState(null)
  const ABOUT = {
    Notifications: "PearList notifies you when someone assigns you an item or a list, when someone joins a space you're in, and - for lists you created - when items get completed. All alerts are local to your device; there is no push server. With this off you'll still see in-app banners while PearList is open.",
    'Background Sync': "Normally PearList only syncs while it's open. With this on it keeps a lightweight connection alive so changes from other members arrive even when the app is closed. Android requires an ongoing notification for that, which is why one stays in your tray. It uses a little more battery. Leave it off if you only need updates when you open the app.",
    'Learned Aisles': "When you move an item to a different aisle - by dragging it, or picking one in the item's detail - PearList remembers that choice on this device. Next time you add an item with the same name it goes straight to that aisle instead of being auto-sorted. It is per-device and never leaves your phone. Clear it to forget every remembered aisle and let items sort automatically again.",
    'Connect Anywhere': "Your phones normally talk straight to each other. Some mobile networks block that direct link, and until it can be made, changes you make away from home sit unsynced. With this on, PearList falls back to a PeerLoom relay that passes the scrambled data along so your lists keep syncing anywhere. The relay cannot read your lists. It only sees that two devices are talking and how much data went by, and it keeps nothing. Turn it off to stay strictly device to device, accepting that on those networks nothing will sync until a direct link works.",
    'Tidy finished aisles': "Check off the last item in an aisle and the aisle folds itself away, so what is left to grab is all that stays on screen. It works the same for the sections you make on other lists. Uncheck something and the aisle comes straight back. Aisles you collapse yourself are left alone. This is just how the list looks on this phone, so it changes nothing for anyone else in your space.",
    'Daily reminder': "Once a day, at the time you pick, PearList reminds you about lists that still have things on them. Shopping lists and notes are never counted: a shopping list is something you take to the shop when you go, not work that is overdue. It says nothing on a day when everything is done. Unlike the other alerts this one is set with your phone in advance, so it arrives even if PearList is closed. It is set per device and nobody else in your space is reminded by yours.",
    'Replay the tour': 'Shows the short walkthrough you got on your first run again: spaces, filling a list, aisles and sections, the on-device AI, notifications, invites and background sync.',
    'Save a copy': "Writes every space you are in - all of them, and everything on their lists - to a single file. You choose where it goes: your phone offers Downloads first, and Documents or a cloud folder are a tap away. Your lists only ever live on your household's phones, so this is the way to have a copy that survives one of them being lost, broken or wiped. The file holds the lists and nothing else: not your name, not the people in your spaces and not the invites, so it cannot let anyone into a space of yours.",
    'Open a saved copy': 'Reads a file saved by "Save a copy" and puts everything in it back as NEW spaces that you own. It never merges into a space you are already in, so nothing you have now can be overwritten or duplicated. Invite the rest of your household to the new spaces the usual way once they are there.',
    'Your devices': "Phones and tablets signed in as you. Pair one and it shares your identity and every space you are in, so your lists are the same on both. Pairing hands over your identity, so only ever do it with a device you own and keep - anyone holding that link becomes you.",
    'Link this phone': 'Use this on the NEW phone: start pairing on a phone you already use, then paste the link it shows here.',
  }
  async function commitAvatar (value) {
    setBusy(true)
    try { await call('profile:set', { displayName: profile?.displayName || name.trim() || 'Me', avatar: value }); onSaved?.() }
    catch (e) { alert(problem('Could not save photo', e)) } finally { setBusy(false) }
  }
  async function onPickFile (e) {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    // GIF / WebP can be animated: store the raw data URL so the motion survives
    // (re-encoding through a canvas would flatten it to a single frame). Cap the
    // size since it is stored inline and replicated to every member. Static
    // images are downscaled + re-encoded to stay tiny.
    const animated = file.type === 'image/gif' || file.type === 'image/webp'
    try {
      if (animated) {
        if (file.size > AVATAR_MAX_BYTES) { alert(`That ${file.type === 'image/gif' ? 'GIF' : 'image'} is too large. Keep it under ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} MB to keep the animation.`); return }
        await commitAvatar(await readFileDataUrl(file))
      } else {
        await commitAvatar(await compressToAvatar(await readFileDataUrl(file)))
      }
    } catch { alert('Could not read that image.') }
  }
  async function saveName () {
    const trimmed = name.trim(); if (!trimmed) return
    setBusy(true)
    try { await call('profile:set', { displayName: trimmed }); onSaved?.() }
    catch (e) { alert(problem('Could not save name', e)) } finally { setBusy(false) }
  }
  const hasAvatar = !!avatarSrc(profile?.avatar)
  const nameDirty = name.trim() && name.trim() !== profile?.displayName
  return (
    <FullScreen title='Settings'>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: sp.base, padding: `${sp.lg}px 0` }}>
        <Avatar name={profile?.displayName || name} avatar={profile?.avatar} size={96} />
        <div style={{ display: 'flex', gap: sp.sm, width: '100%', maxWidth: 280 }}>
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ flex: 1, padding: '10px 16px', borderRadius: r.md, border: `1px solid ${c.text.muted}`, background: c.surface.input, color: c.text.primary, fontSize: 14, cursor: 'pointer' }}>{hasAvatar ? 'Change photo' : 'Add photo'}</button>
          {hasAvatar ? <button onClick={() => commitAvatar(null)} disabled={busy} style={{ flex: 1, padding: '10px 16px', borderRadius: r.md, border: `1px solid ${c.error}`, background: 'transparent', color: c.error, fontSize: 14, cursor: 'pointer' }}>Remove</button> : null}
        </div>
        <input ref={fileRef} type='file' accept='image/*' style={{ display: 'none' }} onChange={onPickFile} />
      </div>

      <label style={{ display: 'block', color: c.text.secondary, fontSize: 13, marginBottom: sp.xs }}>Name</label>
      <div style={{ display: 'flex', gap: sp.sm, marginBottom: sp.lg }}>
        <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder='Your name' style={{ flex: 1, padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none' }} />
        <button onClick={saveName} disabled={busy || !nameDirty} style={{ padding: '0 18px', borderRadius: r.md, border: 'none', background: c.primary, color: c.text.onPrimary, fontSize: 14, cursor: 'pointer', opacity: busy || !nameDirty ? 0.5 : 1 }}>Save</button>
      </div>

      <Group title='Appearance'>
        <Setting first title='Dark mode' control={<Toggle on={theme === 'dark'} onChange={(v) => onTheme(v ? 'dark' : 'light')} />} />
      </Group>
      <Group title='Lists'>
        <Setting onAbout={setInfo} first title='Tidy finished aisles' about={ABOUT['Tidy finished aisles']}
          control={<Toggle on={!!autoCollapse} onChange={(v) => onAutoCollapse(v)} />} />
      </Group>
      <Group title='Connection'>
        <Setting onAbout={setInfo} first title='Connect Anywhere' about={ABOUT['Connect Anywhere']}
          extra={relayStats ? <span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>{relaySummary(relayStats, relayOn)}</span> : null}
          control={<Toggle on={relayOn} onChange={toggleRelay} />} />
      </Group>
      {/* Everything here lives only on the household's phones, so a file is the
          only copy that survives all of them. Also the one way out of a space a
          device cannot sync (see SyncBanner). */}
      <Group title='Backup'>
        <Setting onAbout={setInfo} first title='Save a copy' about={ABOUT['Save a copy']} alignTop
          extra={<span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>{spaceCount
            ? `Saves all ${spaceCount === 1 ? 'your lists' : `${spaceCount} of your spaces and their lists`} to one file.`
            : 'Nothing to save yet.'}</span>}
          control={<button onClick={onExport} disabled={!spaceCount} style={{ ...BACKUP_BTN, border: `1px solid ${spaceCount ? c.text.muted : c.border}`, color: spaceCount ? c.text.primary : c.text.muted, cursor: spaceCount ? 'pointer' : 'default' }}>Save</button>} />
        <Setting onAbout={setInfo} title='Open a saved copy' about={ABOUT['Open a saved copy']} alignTop
          extra={<span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>Puts it all back as new spaces you own.</span>}
          control={<button onClick={onImport} style={{ ...BACKUP_BTN, border: `1px solid ${c.text.muted}`, color: c.text.primary, cursor: 'pointer' }}>Open</button>} />
      </Group>
      {dl?.enabled ? (
        <Group title='Linked devices'>
          <Setting onAbout={setInfo} first title='Your devices' about={ABOUT['Your devices']} alignTop
            extra={<span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>{
              (dl.devices || []).length
                ? (dl.devices || []).map((d) => deviceLabel(d) + ((d.self || d.isThisDevice) ? ' (this phone)' : '')).join(', ')
                : 'Only this phone so far.'
            }</span>}
            control={<div style={{ display: 'flex', gap: sp.sm, flexShrink: 0 }}>
              {(dl.devices || []).length
                ? <button onClick={() => setRoster(true)} style={{ ...BACKUP_BTN, border: `1px solid ${c.text.muted}`, color: c.text.primary, cursor: 'pointer' }}>Manage</button>
                : null}
              <button onClick={pairDevice} style={{ ...BACKUP_BTN, border: `1px solid ${c.text.muted}`, color: c.text.primary, cursor: 'pointer' }}>Pair</button>
            </div>} />
          <Setting onAbout={setInfo} title='Link this phone' about={ABOUT['Link this phone']} alignTop
            extra={<span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>Use the link shown on a phone you already use.</span>}
            control={<button onClick={() => setLinking(true)} style={{ ...BACKUP_BTN, border: `1px solid ${c.text.muted}`, color: c.text.primary, cursor: 'pointer' }}>Link</button>} />
        </Group>
      ) : null}
      {/* CLOSING THIS DOES NOT CANCEL THE PAIRING, and that is deliberate.
          It used to call device:cancelPairing here, which made "Copy link"
          almost useless: the only reason to copy a pair link is to send it from
          another app, and doing that means leaving this screen, which killed the
          session. Found the hard way 2026-07-29 - a link copied and pasted
          seconds later never completed, and the log stopped at
          dl:pairingStarted{role:secondary} with the other phone listening to a
          topic nobody was serving.
          The session is already time-bounded by its own `expires` (~15 min) and
          the LINK is the secret, so whether this sheet is on screen changes who
          can use it not at all. Cancelling on close bought no safety and cost the
          whole copy-and-send path. */}
      <PairLinkSheet open={!!pairUrl} url={pairUrl} onClose={() => { setPairUrl(null); loadDevices() }} />
      <LinkDeviceSheet open={linking} onClose={() => setLinking(false)} onLink={linkThisDevice} />
      <DeviceRosterSheet open={roster} onClose={() => setRoster(false)} devices={dl?.devices}
        onRename={renameThisDevice} onRemove={removeDevice} />
      <Group title='Notifications'>
        <Setting onAbout={setInfo} first title='Notifications' about={ABOUT.Notifications} control={<Toggle on={notif} onChange={toggleNotif} />} />
        <Setting onAbout={setInfo} title='Daily reminder' about={ABOUT['Daily reminder']} alignTop
          extra={reminder.enabled
            // No "Every day at" label: the title already says daily, so the time
            // on its own is unambiguous (Tim's call).
            ? <button onClick={() => setPickTime(true)} aria-label='Daily reminder time'
                style={{ alignSelf: 'flex-start', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.sm, padding: '7px 14px', fontSize: 13, fontFamily: FONT, cursor: 'pointer' }}>{reminderTime}</button>
            : null}
          control={<Toggle on={reminder.enabled} onChange={(v) => saveReminder({ ...reminder, enabled: v })} />} />
        {bgSyncSupported ? <Setting onAbout={setInfo} title='Background Sync' about={ABOUT['Background Sync']} control={<Toggle on={bgSync} onChange={toggleBgSync} />} /> : null}
      </Group>
      <Group title='Aisles'>
        <Setting onAbout={setInfo} title='Learned Aisles' about={ABOUT['Learned Aisles']}
          extra={learned ? <span style={{ color: c.text.muted, fontSize: 12, lineHeight: 1.35 }}>Remembering {learned} item{learned > 1 ? 's' : ''}.</span> : null}
          control={<button onClick={clearLearned} disabled={!learned} aria-label='Clear learned aisles' style={{ width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: r.md, border: 'none', background: 'none', color: learned ? c.error : c.text.muted, cursor: learned ? 'pointer' : 'default', opacity: learned ? 1 : 0.4 }}><Trash size={20} weight='regular' /></button>} />
      </Group>
      <TimeOfDaySheet open={pickTime} hour={reminder.hour} minute={reminder.minute}
        onClose={() => setPickTime(false)}
        onPick={(h, m) => saveReminder({ ...reminder, hour: h, minute: m })} />
      <Group title='Help'>
        <Setting onAbout={setInfo} first title='Replay the tour' about={ABOUT['Replay the tour']}
          control={<button onClick={onReplayTour} style={{ padding: '8px 16px', flexShrink: 0, borderRadius: r.md, border: `1px solid ${c.text.muted}`, background: c.surface.input, color: c.text.primary, fontSize: 14, cursor: 'pointer' }}>Replay</button>} />
      </Group>
      <BottomSheet open={!!info} onClose={() => setInfo(null)} title={info?.title}>
        <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.55, margin: 0 }}>{info?.body}</p>
        {info?.link ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: sp.base }}>
            <button onClick={() => openUrl(info.link.url)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: c.primary, fontSize: 14, fontWeight: 400 }}>
              {info.link.label}<ArrowSquareOut size={16} weight='regular' />
            </button>
          </div>
        ) : null}
      </BottomSheet>
    </FullScreen>
  )
}

function AboutView ({ onWallet }) {
  const [section, setSection] = useState(null)
  const toggle = (id) => setSection((s) => s === id ? null : id)
  // BTC is a chooser, not an auto-fire: always open the sheet, passing whether a
  // Lightning wallet is installed so it can offer the one-tap hand-off. On iOS the
  // probe only works because `lightning` is declared in LSApplicationQueriesSchemes
  // (app.json); without that, canOpenURL silently returns false for every scheme.
  async function donateBTC () {
    let can = false
    try { const r = await call('shell:canOpenURL', { url: 'lightning:test' }); can = !!r?.can } catch {}
    onWallet(can)
  }
  const P = ({ children }) => <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.5, margin: `0 0 ${sp.md}px` }}>{children}</p>
  const Pill = ({ onClick, children, primary }) => <button onClick={onClick} style={{ flex: 1, padding: '10px 12px', borderRadius: r.md, border: primary ? 'none' : `1px solid ${c.text.muted}`, background: primary ? c.primary : c.surface.input, color: primary ? c.text.onPrimary : c.text.primary, fontSize: 14, cursor: 'pointer' }}>{children}</button>
  return (
    <FullScreen title='About'>
      <div style={{ textAlign: 'center', marginBottom: sp.lg }}>
        <h2 style={{ fontSize: 22, fontWeight: 400, margin: 0, color: c.text.primary }}>PearList</h2>
        <p style={{ color: c.text.muted, fontSize: 14, marginTop: sp.xs }}>Private. Peer-to-Peer. No Servers.</p>
      </div>

      <Collapsible title='How it works' open={section === 'how'} onToggle={() => toggle('how')}>
        <P>PearList syncs your household's lists directly between devices using peer-to-peer technology powered by Hypercore Protocol. Your lists never touch a server - they live only on the devices in your household. No accounts. No subscriptions. No data collection.</P>
        <div style={{ display: 'flex' }}><Pill onClick={() => openUrl('https://pears.com/')}>Learn about P2P ↗</Pill></div>
      </Collapsible>

      <Collapsible title='Support development' open={section === 'support'} onToggle={() => toggle('support')}>
        <P>PearList is free and open source. If you receive value from it, please consider returning value.</P>
        <div style={{ display: 'flex', gap: sp.sm }}>
          <Pill primary onClick={donateBTC}>⚡ BTC ⚡</Pill>
          <Pill onClick={() => openUrl(BUYMEACOFFEE_URL)}>$ USD $</Pill>
        </div>
      </Collapsible>

      <Collapsible title='Learn about Bitcoin' open={section === 'btc'} onToggle={() => toggle('btc')}>
        <P>New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash course explaining how Bitcoin works and why it matters.</P>
        <div style={{ display: 'flex' }}><Pill onClick={() => openUrl('https://nakamotoinstitute.org/crash-course/')}>Bitcoin Crash Course ↗</Pill></div>
      </Collapsible>

      <Collapsible title='Share the app' open={section === 'share'} onToggle={() => toggle('share')}>
        <P>Know someone who'd want a private, serverless way to share lists with their household? Share PearList with them.</P>
        <div style={{ display: 'flex' }}><Pill onClick={() => call('shell:share', { title: 'PearList', text: 'Check out PearList - a private, peer-to-peer shared-list app with no servers or accounts.\n\nhttps://peerloomllc.com/pearlist/' })}>Share PearList</Pill></div>
      </Collapsible>

      <Collapsible title='Contact' open={section === 'contact'} onToggle={() => toggle('contact')}>
        <div style={{ display: 'flex', gap: sp.sm }}>
          <Pill onClick={() => openUrl('mailto:peerloomllc@proton.me?subject=%5BPearList%5D%20Feedback')}>Email</Pill>
          <Pill onClick={() => openUrl('https://github.com/peerloomllc/pearlist/issues')}>Issue</Pill>
        </div>
      </Collapsible>

      <p style={{ textAlign: 'center', color: c.text.muted, fontSize: 13, marginTop: sp.lg }}>v{APP_VERSION}</p>
    </FullScreen>
  )
}

// Copyable address row: monospaced value + a Copy button that flashes "Copied".
// Copies route through the shell (shell:clipboard) because navigator.clipboard is
// unreliable in the about:blank WebView. Shared height keeps it aligned with the
// buttons and wallet rows in the donation sheet.
function CopyField ({ value, hint }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      const res = await call('shell:clipboard', { text: value })
      if (res?.ok !== false) {
        haptic('light')
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }
    } catch {}
  }
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: sp.sm,
        background: c.surface.card, border: `1px solid ${c.border}`,
        borderRadius: r.lg, padding: `${sp.sm + 2}px ${sp.md}px`,
        minHeight: DONATE_OPTION_MIN_H, boxSizing: 'border-box',
      }}>
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: MONO, fontSize: 13, color: c.text.primary,
        }}>{value}</span>
        <button onClick={copy} style={{
          flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: FONT, fontSize: 13, fontWeight: 400,
          color: copied ? c.success : c.primary,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          {copied ? <><CheckCircle size={14} weight='fill' /> Copied</> : 'Copy'}
        </button>
      </div>
      {hint && (
        <p style={{ fontSize: 13, fontWeight: 300, color: c.text.muted, margin: `${sp.xs}px 0 0`, lineHeight: 1.5, textAlign: 'center' }}>{hint}</p>
      )}
    </div>
  )
}

// BTC donation chooser. Reached from About -> Support development -> BTC. Always
// a chooser (never auto-fires): if a Lightning wallet is detected it offers a
// one-tap hand-off; otherwise the copy/QR alternatives plus a wallet-install
// list are the whole sheet. Fiat is the separate USD button, so this is BTC-only.
function LightningWalletModal ({ open, detected = false, onClose }) {
  const body = { fontSize: 14, fontWeight: 300, color: c.text.secondary, lineHeight: 1.7 }
  const secLabel = { fontSize: 13, fontWeight: 400, color: c.text.secondary, margin: `${sp.lg}px 0 ${sp.sm}px`, textAlign: 'center' }
  const caption = { fontSize: 13, fontWeight: 300, color: c.text.muted, lineHeight: 1.5, textAlign: 'center' }
  const primaryBtn = {
    width: '100%', padding: `${sp.md}px ${sp.base}px`,
    minHeight: DONATE_OPTION_MIN_H, boxSizing: 'border-box',
    background: c.primary, color: c.text.onPrimary,
    border: 'none', borderRadius: r.lg, cursor: 'pointer',
    fontFamily: FONT, fontSize: 15, fontWeight: 400,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: sp.sm,
  }
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div style={{ fontSize: 18, fontWeight: 400, color: c.text.primary, marginBottom: sp.xs + 2, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: sp.sm, fontFamily: FONT }}>
        <Lightning size={18} weight='thin' /> Bitcoin Lightning <Lightning size={18} weight='thin' />
      </div>
      <p style={{ ...body, marginBottom: sp.base, textAlign: 'center' }}>
        Support PearList with Bitcoin over Lightning (fast and
        low-fee){BTC_ONCHAIN_ADDRESS ? ' or on-chain' : ''}.
      </p>

      {detected && (
        <>
          <button onClick={() => { openUrl('lightning:' + LIGHTNING_ADDRESS); onClose() }} style={primaryBtn}>
            <Lightning size={16} weight='fill' /> Open in your Lightning wallet <Lightning size={16} weight='fill' />
          </button>
          <p style={{ ...body, textAlign: 'center', margin: `${sp.base}px 0 0` }}>or use another method:</p>
        </>
      )}

      <p style={{ ...secLabel, marginTop: detected ? sp.base : sp.md }}>Lightning address</p>
      <CopyField value={LIGHTNING_ADDRESS} hint='Paste into any Lightning, ecash or web wallet.' />

      <div style={{ marginTop: sp.base }}>
        <button onClick={() => { openUrl(STRIKE_TIP_URL); onClose() }} style={primaryBtn}>
          <Lightning size={16} weight='fill' /> Show a QR / pay in a browser <Lightning size={16} weight='fill' />
        </button>
        <p style={{ ...caption, margin: `${sp.xs}px 0 0` }}>Scan from another device or on desktop.</p>
      </div>

      {BTC_ONCHAIN_ADDRESS && (
        <>
          <p style={secLabel}>On-chain Bitcoin</p>
          <CopyField value={BTC_ONCHAIN_ADDRESS} hint='On-chain BTC. Higher fees, so Lightning is cheaper for small tips.' />
        </>
      )}

      {!detected && (
        <>
          <p style={{ ...body, textAlign: 'center', margin: `${sp.lg}px 0 ${sp.sm}px` }}>
            Don't have a Lightning wallet?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: sp.sm + 2 }}>
            {LIGHTNING_WALLETS.map((w) => (
              <button key={w.name} onClick={() => openUrl(w.url)} style={{
                background: c.surface.card, border: `1px solid ${c.border}`,
                borderRadius: r.lg, padding: `${sp.sm + 2}px ${sp.base}px`,
                minHeight: DONATE_OPTION_MIN_H, boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', gap: sp.md,
                cursor: 'pointer', width: '100%', textAlign: 'left',
                fontFamily: FONT,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 400, color: c.text.primary }}>{w.name}</div>
                  <div style={{ fontSize: 12, fontWeight: 300, color: c.text.muted }}>{w.desc}</div>
                </div>
                <ArrowSquareOut size={14} weight='thin' color={c.text.muted} />
              </button>
            ))}
          </div>
          <p style={{ ...body, textAlign: 'center', marginTop: sp.base, marginBottom: 0 }}>
            After installing, return here and tap BTC again.
          </p>
        </>
      )}
    </BottomSheet>
  )
}

// Quick quantity stepper shown right after adding an item to a grocery list.
// Defaults to 1; dismissing keeps 1 (item:add already stored qty 1), Done saves.
// Grocery quantity step. The item is added only when this closes - via Done OR a
// backdrop dismiss - both routed through a single guarded commit so the row is
// never added twice and always lands after the sheet is gone.
function QtySheet ({ open, onCommit }) {
  const [qty, setQty] = useState(1)
  const committed = useRef(false)
  useEffect(() => { if (open) { setQty(1); committed.current = false } }, [open])
  const commit = () => { if (committed.current) return; committed.current = true; onCommit(qty) }
  const stepBtn = { width: 48, height: 48, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }
  return (
    <BottomSheet open={open} onClose={commit} title='How many?'>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: sp.lg, margin: `${sp.sm}px 0 ${sp.lg}px` }}>
        <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label='Decrease' style={stepBtn}><Minus size={22} weight='bold' /></button>
        <span style={{ fontFamily: MONO, fontSize: 28, color: c.text.primary, minWidth: 56, textAlign: 'center' }}>{qty}</span>
        <button onClick={() => setQty((q) => q + 1)} aria-label='Increase' style={stepBtn}><Plus size={22} weight='bold' /></button>
      </div>
      <Button onClick={commit}>Done</Button>
    </BottomSheet>
  )
}

// Edit one item: its text, quantity, note, link, assignee and aisle/section.
// `noun` labels the grouping field for the list kind ('aisle' for groceries,
// 'section' otherwise); onSave commits, onDelete removes.
// Both label columns in the item sheet share this width, so "Remind" and
// "Repeats" - different lengths - still line their input boxes up on the same
// left edge.
const FIELD_LABEL_W = 74

// The row stores an absolute epoch, and the picker deals in the same, so a
// reminder set by someone in another timezone fires at the same INSTANT
// everywhere - what a household wants, rather than a floating local time nobody
// asked for. This is only how that instant reads to a person.
function whenLabel (ms) {
  const d = describeWhen(ms, Date.now())
  return d ? `${d.day}, ${d.time}` : 'Never'
}

function ItemSheet ({ open, item, kind, noun = 'aisle', builtins = aisles.AISLES, customAisles, members, selfPubkey, onClose, onSave, onDelete }) {
  const [text, setText] = useState('')
  const [qty, setQty] = useState(1)
  const [assignee, setAssignee] = useState(null)
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  const [category, setCategory] = useState(null)
  const [catTouched, setCatTouched] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickingAisle, setPickingAisle] = useState(false)
  const [remindAt, setRemindAt] = useState(null)
  const [repeat, setRepeat] = useState('')
  const [pickWhen, setPickWhen] = useState(false)
  useEffect(() => { if (open && item) { setText(item.text || ''); setQty(item.qty || 1); setAssignee(item.assignee || null); setNote(item.note || ''); setUrl(item.url || ''); setCategory(item.category || null); setCatTouched(false); setPicking(false); setPickingAisle(false); setRemindAt(typeof item.remindAt === 'number' ? item.remindAt : null); setRepeat(item.repeat || '') } }, [open, item])
  if (!item) return null
  const isGrocery = kind === 'grocery'
  const nounLabel = noun.charAt(0).toUpperCase() + noun.slice(1) // "Aisle" / "Section"
  return (
    <>
      <BottomSheet open={open} onClose={onClose} title='Edit item'>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
          <Field value={text} onChange={setText} placeholder='Item' />
          {/* Quantity is a grocery notion; chores/to-dos/generic lists have no use
              for it, so the stepper is grocery-only (the qty value is preserved). */}
          {isGrocery ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: sp.md }}>
              <span style={{ color: c.text.secondary, fontSize: 14, width: 70 }}>Quantity</span>
              <button onClick={() => setQty((q) => Math.max(1, q - 1))} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Minus size={18} weight='bold' /></button>
              <span style={{ fontFamily: MONO, fontSize: 16, color: c.text.primary, minWidth: 24, textAlign: 'center' }}>{qty}</span>
              <button onClick={() => setQty((q) => q + 1)} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={18} weight='bold' /></button>
            </div>
          ) : null}
          <button onClick={() => setPicking(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: sp.md, padding: '12px 14px', background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, cursor: 'pointer' }}>
            <span style={{ color: c.text.secondary, fontSize: 14 }}>Assigned to</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: sp.sm, color: c.text.primary, fontSize: 15 }}>
              {assignee ? <AssigneeAvatar pubkey={assignee} members={members} size={22} /> : null}
              {memberLabel(members, assignee, selfPubkey)}
              <CaretRight size={16} color={c.text.muted} weight='regular' />
            </span>
          </button>
          <button onClick={() => setPickingAisle(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: sp.md, padding: '12px 14px', background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, cursor: 'pointer' }}>
            <span style={{ color: c.text.secondary, fontSize: 14 }}>{nounLabel}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: sp.sm, color: c.text.primary, fontSize: 15 }}>
              {category || (isGrocery ? aisles.FALLBACK : 'None')}
              <CaretRight size={16} color={c.text.muted} weight='regular' />
            </span>
          </button>
          {/* One reminder, one instant. No snooze: whoever the item is assigned to
              is who gets it (falling back to the list's assignee, then its
              creator), so exactly one phone rings. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: sp.sm }}>
            <span style={{ color: c.text.secondary, fontSize: 14, width: FIELD_LABEL_W, flexShrink: 0 }}>Remind</span>
            <button onClick={() => setPickWhen(true)} aria-label='Reminder time'
              style={{ flex: 1, minWidth: 0, padding: '10px 12px', textAlign: 'left', background: c.surface.input, color: remindAt ? c.text.primary : c.text.muted, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, cursor: 'pointer' }}>
              {remindAt ? whenLabel(remindAt) : 'Never'}
            </button>
            {remindAt ? <button onClick={() => setRemindAt(null)} aria-label='Clear reminder' style={{ width: 46, flexShrink: 0, height: 42, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.error, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash size={18} weight='regular' /></button> : null}
          </div>
          {remindAt && remindAt <= Date.now()
            ? <span style={{ color: c.error, fontSize: 12, marginTop: -6 }}>That time has already passed, so nothing would fire. Pick a later one.</span>
            : null}
          {/* A chore that comes back. Nothing resets it on a timer: checking it off
              records WHEN, and whether it is open now is worked out from that at
              read time (proposals/2026-07-27-recurring-chores.md). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: sp.sm }}>
            <span style={{ color: c.text.secondary, fontSize: 14, width: FIELD_LABEL_W, flexShrink: 0 }}>Repeats</span>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label='Repeats'
              style={{ flex: 1, minWidth: 0, padding: '10px 12px', background: c.surface.input, color: repeat ? c.text.primary : c.text.muted, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, outline: 'none' }}>
              <option value=''>Never</option>
              <option value='daily'>Every day</option>
              <option value='weekly'>Every week</option>
              <option value='monthly'>Every month</option>
            </select>
          </div>
          {/* Only worth saying when it is closed: an open chore is due NOW. */}
          {repeat && repeat === item.repeat && item.checked && item.nextDueAt
            ? <span style={{ color: c.text.muted, fontSize: 12, marginTop: -6 }}>Done for now. Back on {new Date(item.nextDueAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}.</span>
            : null}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder='Notes (optional)' rows={2} maxLength={2000}
            style={{ width: '100%', padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, outline: 'none', resize: 'vertical', minHeight: 44 }} />
          <div style={{ display: 'flex', gap: sp.sm }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='Link (optional, e.g. store page)' inputMode='url' autoCapitalize='none' autoCorrect='off'
              style={{ flex: 1, minWidth: 0, padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, outline: 'none' }} />
            {url.trim() ? <button onClick={() => openUrl(url.trim().match(/^https?:\/\//i) ? url.trim() : 'https://' + url.trim())} aria-label='Open link' style={{ width: 46, flexShrink: 0, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.accent, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LinkIcon /></button> : null}
          </div>
          <Button onClick={() => onSave({ text: text.trim(), qty, assignee, note: note.trim(), url: url.trim(), category, catTouched, remindAt, repeat })}>Save</Button>
          <Button variant='danger' onClick={onDelete}>Delete item</Button>
        </div>
      </BottomSheet>
      <WhenSheet open={pickWhen} value={remindAt} onClose={() => setPickWhen(false)}
        onPick={(ms) => setRemindAt(ms)} onClear={() => setRemindAt(null)} />
      <AssigneePickerSheet open={picking} onClose={() => setPicking(false)} members={members} selfPubkey={selfPubkey} current={assignee} onPick={(pk) => setAssignee(pk)} />
      <AislePickerSheet open={pickingAisle} onClose={() => setPickingAisle(false)} noun={noun} builtins={builtins} current={category} custom={customAisles} onPick={(a) => { setCategory(a); setCatTouched(true) }} />
    </>
  )
}
