import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { call, on, isMock, haptic } from './ipc.js'
import { colors as c, spacing as sp, radius as r, FONT, MONO, setTheme, loadTheme } from './theme.js'
import { ShareNetwork, Trash, Link, CaretRight, CaretLeft, CaretDown, X, Check, Plus, Minus, DotsThree } from '@phosphor-icons/react'

// From app.json once the shell exists; hardcoded for now.
const APP_VERSION = '0.0.1'
// Suite donation config (shared across PeerLoom apps).
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const LIGHTNING_WALLETS = [
  { name: 'Strike', url: 'https://strike.me', desc: 'Simple Lightning payments' },
  { name: 'Cash App', url: 'https://cash.app', desc: 'Send Bitcoin via Lightning' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com', desc: 'Beginner-friendly Lightning wallet' },
  { name: 'Phoenix', url: 'https://phoenix.acinq.co', desc: 'Self-custodial Lightning wallet' },
]
// The shell injects window.__pearPlatform ('ios'|'android') before the bundle.
// iOS hides the donation section per App Store guideline 3.1.1.
const isIOS = () => typeof window !== 'undefined' && window.__pearPlatform === 'ios'

const openUrl = (url) => { try { call('shell:openUrl', { url }) } catch {} }

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
    danger: { background: 'transparent', color: c.error, border: `1px solid ${c.error}` },
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, background: shown ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)', transition: 'background 280ms ease', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 600, background: c.surface.card, borderRadius: `${r.sheet}px ${r.sheet}px 0 0`, maxHeight: '85dvh', overflowY: 'auto', transform: shown ? 'translateY(0)' : 'translateY(100%)', transition: 'transform 280ms cubic-bezier(0.32,0.72,0,1)', padding: `${sp.sm}px ${sp.lg}px calc(var(--pear-safe-bottom) + ${sp.xl}px)` }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: c.text.muted, margin: '6px auto 14px' }} />
        {title ? <h2 style={{ textAlign: 'center', fontSize: 17, fontWeight: 400, margin: `0 0 ${sp.base}px`, color: c.text.primary }}>{title}</h2> : null}
        {children}
      </div>
    </div>
  )
}

function Toggle ({ on: isOn, onChange }) {
  return (
    <button onClick={() => onChange(!isOn)} aria-label='toggle' style={{ width: 44, height: 26, borderRadius: r.full, border: 'none', cursor: 'pointer', background: isOn ? c.primary : c.track, position: 'relative', transition: 'background 160ms', padding: 0 }}>
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
function AssigneeAvatar ({ pubkey, members, size = 22 }) {
  if (!pubkey) return null
  const m = members.find((x) => x.pubkey === pubkey)
  return <Avatar name={m?.displayName || '?'} avatar={m?.avatar} size={size} />
}
function memberLabel (members, pubkey, selfPubkey) {
  if (!pubkey) return 'Nobody'
  const m = members.find((x) => x.pubkey === pubkey)
  const base = m?.displayName || 'Unknown'
  return pubkey === selfPubkey ? base + ' (You)' : base
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
function FullScreen ({ open, title, onBack, children }) {
  const [render, setRender] = useState(open)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) { setRender(true); const t = setTimeout(() => setShown(true), 20); return () => clearTimeout(t) }
    setShown(false); const t = setTimeout(() => setRender(false), 280); return () => clearTimeout(t)
  }, [open])
  if (!render) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: c.surface.base, transform: shown ? 'translateY(0)' : 'translateY(100%)', transition: 'transform 280ms cubic-bezier(0.32,0.72,0,1)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `calc(var(--pear-safe-top) + ${sp.md}px) ${sp.base}px ${sp.md}px`, borderBottom: `1px solid ${c.border}` }}>
        <button onClick={onBack} aria-label='Back' style={{ width: 36, height: 36, background: 'none', border: 'none', color: c.text.secondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CaretLeft size={24} weight='regular' /></button>
        <h1 style={{ flex: 1, textAlign: 'center', fontSize: 20, fontWeight: 400, margin: 0, color: c.text.primary }}>{title}</h1>
        <span style={{ width: 36 }} />
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: sp.base, maxWidth: 600, width: '100%', margin: '0 auto' }}>{children}</div>
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: '#000' }}>
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp.xl }}>
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
function SwipeRow ({ children, onDelete }) {
  const start = useRef(null)
  const axis = useRef(null)
  const dxRef = useRef(0)
  const wrap = useRef(null)
  const [dx, setDxState] = useState(0)
  const [dragging, setDragging] = useState(false)
  const THRESHOLD = 88
  const setDx = (v) => { dxRef.current = v; setDxState(v) }
  const reset = () => { start.current = null; axis.current = null; setDragging(false); setDx(0) }
  const onStart = (e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; axis.current = null; setDragging(true) }
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
      <div aria-hidden='true' style={{ position: 'absolute', inset: 0, background: c.error, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 22, color: '#fff' }}><TrashIcon /></div>
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={reset}
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform 200ms cubic-bezier(0.32,0.72,0,1)', background: c.surface.base, touchAction: 'pan-y', position: 'relative', willChange: 'transform' }}>
        {children}
      </div>
    </div>
  )
}

// Transient "Item deleted · Undo" toast, above the composer.
function UndoToast ({ onUndo }) {
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 'calc(var(--pear-safe-bottom) + 84px)', transform: 'translateX(-50%)', zIndex: 80, maxWidth: 560, width: 'calc(100% - 24px)', background: c.surface.elevated, color: c.text.primary, padding: '10px 8px 10px 16px', borderRadius: r.lg, fontSize: 14, display: 'flex', alignItems: 'center', gap: sp.sm, boxShadow: '0 6px 20px rgba(0,0,0,0.45)', border: `1px solid ${c.border}` }}>
      <span style={{ flex: 1 }}>Item deleted</span>
      <button onClick={onUndo} style={{ background: 'none', border: 'none', color: c.primary, fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: '4px 14px' }}>Undo</button>
    </div>
  )
}

function ItemRow ({ item, members, onToggle, onOpen }) {
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function Onboarding ({ onStart, onJoin }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: sp.xl, gap: sp.base, maxWidth: 460, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: sp.lg }}>
        <div style={{ fontSize: 40, marginBottom: sp.sm }}>🍐</div>
        <h1 style={{ fontSize: 28, fontWeight: 400, margin: 0, color: c.text.primary }}>PearList</h1>
        <p style={{ color: c.text.secondary, fontSize: 15, fontWeight: 300, marginTop: sp.sm }}>Shared lists, one private space per group. No account, no server.</p>
      </div>
      <Button variant='primary' onClick={onStart}>Create a space</Button>
      <Button variant='secondary' onClick={onJoin}>Join with an invite</Button>
      {isMock ? <p style={{ textAlign: 'center', color: c.text.muted, fontSize: 12, marginTop: sp.base }}>preview mode (no peer sync)</p> : null}
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

export default function App () {
  const [phase, setPhase] = useState('loading')
  const [spaces, setSpaces] = useState([])
  const [activeSpaceId, setActiveSpaceId] = useState(null)
  const [lists, setLists] = useState([])
  const [openListId, setOpenListId] = useState(null)
  const [items, setItems] = useState([])
  const [theme, setThemeMode] = useState('dark')
  const [sheet, setSheet] = useState(null) // 'start'|'join'|'invite'|'menu'|'wallet'|'spaces'|'listOptions'|'renameList'|{type:'item',item}
  const [view, setView] = useState(null) // full-screen: 'profile' | 'about'
  const [profile, setProfile] = useState(null)
  const [donateReminder, setDonateReminder] = useState(false)
  const [members, setMembers] = useState([])
  const [selfPubkey, setSelfPubkey] = useState(null)
  const [banner, setBanner] = useState(null)     // transient toast (e.g. "Alex joined")
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

  // Refresh the household roster, and publish our own member row once we are a
  // writable member and not yet listed (so peers can resolve our assignee pubkey).
  const loadMembers = useCallback(async (groupId, self) => {
    const ms = await call('member:getAll', { groupId }).catch(() => [])
    setMembers(ms)
    if (self && !ms.some((m) => m.pubkey === self)) call('member:publish', { groupId }).catch(() => {})
    // "Someone joined" banner: fire only for a member that appears after we have
    // already seen this space's roster once (skips the initial load and self).
    const prev = prevMembersRef.current[groupId]
    if (prev) {
      const added = ms.find((m) => !prev.has(m.pubkey) && m.pubkey !== self)
      if (added) setBanner(`${added.displayName || 'Someone'} joined`)
    }
    prevMembersRef.current[groupId] = new Set(ms.map((m) => m.pubkey))
    return ms
  }, [])

  // Boot.
  useEffect(() => {
    setThemeMode(loadTheme())
    ;(async () => {
      await call('init', {})
      call('profile:get', {}).then(setProfile).catch(() => {})
      call('identity:get', {}).then((r) => setSelfPubkey(r?.pubkey || null)).catch(() => {})
      const sp = await loadSpaces()
      if (sp.length) { setActiveSpaceId(sp[0].groupId); setPhase('home') }
      else setPhase('onboarding')
    })().catch((e) => { console.error(e); setPhase('onboarding') })
  }, [loadSpaces])

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

  // Poll lists + the open list's items + roster so a peer's changes show up.
  // Lists must be in here too, else a peer's list rename/delete/add only lands
  // when the local user switches spaces. Cheap for a list app.
  useEffect(() => {
    if (phase !== 'home' || !gid) return
    const refresh = () => { loadLists(gid); loadItems(gid, openListId); loadMembers(gid, selfPubkey) }
    refresh()
    const t = setInterval(refresh, 2500)
    const off = on('peer:connected', () => refresh())
    return () => { clearInterval(t); off() }
  }, [phase, gid, openListId, selfPubkey, loadItems, loadLists, loadMembers])

  // Two-week donation nudge: check once on reaching home, skip on iOS, show only
  // once ever (mark shown as soon as it surfaces).
  useEffect(() => {
    if (phase !== 'home' || isIOS()) return
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
      joinSpace(url).catch((e) => setBanner('Could not open that invite: ' + (e?.message || e)))
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
    if (!inviteKey) throw new Error('that does not look like an invite link')
    const { groupId } = await call('group:join', { inviteKey })
    await loadSpaces()
    setActiveSpaceId(groupId); setOpenListId(null); setPhase('home'); setSheet(null)
    call('member:publish', { groupId }).catch(() => {}) // retried by the poll until writable
  }
  function switchSpace (groupId) {
    setActiveSpaceId(groupId); setOpenListId(null); setSheet(null)
  }
  async function deleteSpace (targetId) {
    const id = targetId || activeSpaceId; if (!id) return
    setSheet(null); setDeleteTarget(null)
    try { await call('space:delete', { groupId: id }) } catch (e) { alert('Could not delete space: ' + e.message); return }
    const sp = await loadSpaces()
    // Only move off if we deleted the space we were viewing.
    if (!sp.some((s) => s.groupId === activeSpaceId)) { setOpenListId(null); setActiveSpaceId(sp[0]?.groupId || null) }
    if (sp.length === 0) setPhase('onboarding')
    setBanner('Space deleted.')
  }
  async function assignList (listId, assignee) {
    await call('list:assign', { groupId: gid, listId, assignee })
    await loadLists(gid)
  }
  async function addItemText (text) {
    const t = String(text || '').trim(); if (!t || !gid || !openListId) return
    setDraft(''); setSuggestions([])
    await call('item:add', { groupId: gid, listId: openListId, text: t })
    await loadItems(gid, openListId)
    composer.current?.blur?.() // dismiss the keyboard; show the full list
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
    setItems((cur) => cur.map(i => i.id === item.id ? { ...i, checked: !item.checked } : i)) // optimistic
    await call('item:toggle', { groupId: gid, listId: openListId, itemId: item.id, checked: !item.checked })
    loadItems(gid, openListId)
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
  async function addList () {
    const name = listDraft.trim(); if (!name || !gid) return
    setListDraft('')
    await call('list:create', { groupId: gid, name })
    await loadLists(gid)               // new list appears in the overview; do not auto-open
    listComposer.current?.blur?.()     // dismiss the keyboard; show the full lists page
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
  async function applyTheme (mode) { setTheme(mode); setThemeMode(mode) }

  if (phase === 'loading') {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={28} /></div>
  }
  if (phase === 'onboarding') {
    return (
      <>
        <Onboarding onStart={() => setSheet('start')} onJoin={() => setSheet('join')} />
        <StartSheet open={sheet === 'start'} onClose={() => setSheet(null)} onCreate={createSpace} />
        <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} onJoin={joinSpace} />
      </>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: 600, margin: '0 auto' }}>
      {banner ? <Banner text={banner} onClose={() => setBanner(null)} /> : null}
      {openListId === null ? (
        // ===== Lists overview: all lists in the space + persistent add-list bar =====
        <>
          <TopBar
            title={<button onClick={() => setSheet('spaces')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 20, fontWeight: 400, fontFamily: FONT, maxWidth: '100%' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeSpace?.name || 'Space'}</span><CaretDown size={16} color={c.text.muted} weight='regular' /></button>}
            left={<button aria-label='Menu' onClick={() => setSheet('menu')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}><Avatar name={profile?.displayName} avatar={profile?.avatar} size={30} /></button>}
            right={<IconButton label='Invite' onClick={() => setSheet('invite')}><ShareIcon /></IconButton>}
          />
          <MembersBar members={members} onOpen={() => setSheet('members')} />
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 80 }}>
            {lists.length === 0
              ? <div style={{ textAlign: 'center', color: c.text.muted, fontSize: 15, padding: `${sp.xxxl}px ${sp.xl}px` }}>No lists in {activeSpace?.name || 'this space'} yet. Add one below.</div>
              : lists.map((l) => <ListRow key={l.id} list={l} members={members} onOpen={() => setOpenListId(l.id)} />)}
          </div>
          <ComposerBar inputRef={listComposer} value={listDraft} onChange={setListDraft} onSubmit={addList} placeholder='Add a list' />
        </>
      ) : (
        // ===== List detail: the items of the open list + add-item bar =====
        <>
          <DetailHeader title={openList?.name || 'List'} assignee={openList?.assignee} members={members} onBack={() => setOpenListId(null)} onOptions={() => setSheet('listOptions')} />
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 80 }}>
            {items.length === 0
              ? <div style={{ textAlign: 'center', color: c.text.muted, fontSize: 15, padding: `${sp.xxxl}px ${sp.xl}px` }}>Nothing here yet. Add the first thing below.</div>
              : items.map((it) => (
                <SwipeRow key={it.id} onDelete={() => swipeDeleteItem(it)}>
                  <ItemRow item={it} members={members} onToggle={toggleItem} onOpen={(item) => setSheet({ type: 'item', item })} />
                </SwipeRow>
              ))}
          </div>
          {pendingUndo ? <UndoToast onUndo={undoDelete} /> : null}
          <div style={{ position: 'sticky', bottom: 0, background: c.surface.base }}>
            {suggestions.length ? <SuggestionBar items={suggestions} onPick={(t) => addItemText(t)} /> : null}
            <ComposerBar inputRef={composer} value={draft} onChange={setDraft} onSubmit={addItem} placeholder='Add an item' />
          </div>
        </>
      )}

      <InviteSheet open={sheet === 'invite'} onClose={() => setSheet(null)} inviteKey={activeSpace?.inviteKey} spaceName={activeSpace?.name} />
      <SpaceSwitcherSheet open={sheet === 'spaces'} onClose={() => setSheet(null)} spaces={spaces} activeId={activeSpaceId}
        onPick={switchSpace} onCreate={() => setSheet('start')} onJoin={() => setSheet('join')}
        onDelete={(s) => { setDeleteTarget(s); setSheet('deleteSpace') }} />
      <StartSheet open={sheet === 'start'} onClose={() => setSheet(null)} onCreate={createSpace} />
      <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} onJoin={joinSpace} />
      <ListOptionsSheet open={sheet === 'listOptions'} list={openList} members={members} onClose={() => setSheet(null)}
        onRename={() => setSheet('renameList')}
        onAssign={() => { setSheet(null); setListPicker({ listId: openListId, current: openList?.assignee || null }) }}
        onDelete={deleteOpenList} />
      <RenameListSheet open={sheet === 'renameList'} current={openList?.name} onClose={() => setSheet(null)} onSave={renameList} />
      <MenuSheet open={sheet === 'menu'} onClose={() => setSheet(null)} profile={profile}
        onProfile={() => { setSheet(null); setView('profile') }}
        onAbout={() => { setSheet(null); setView('about') }} />
      <MembersSheet open={sheet === 'members'} onClose={() => setSheet(null)} members={members} selfPubkey={selfPubkey} spaceName={activeSpace?.name} />
      <DeleteSpaceSheet open={sheet === 'deleteSpace'} onClose={() => { setSheet(null); setDeleteTarget(null) }} spaceName={deleteTarget?.name} onConfirm={() => deleteSpace(deleteTarget?.groupId)} />
      <ProfileView open={view === 'profile'} onBack={() => setView(null)} profile={profile} theme={theme} onTheme={applyTheme}
        onSaved={() => call('profile:get', {}).then(setProfile).catch(() => {})} />
      <AboutView open={view === 'about'} onBack={() => setView(null)} onWallet={() => setSheet('wallet')} />
      <LightningWalletSheet open={sheet === 'wallet'} onClose={() => setSheet(null)} />
      <DonationReminderModal open={donateReminder} onDismiss={() => setDonateReminder(false)} onDonate={() => { setDonateReminder(false); setView('about') }} />
      <ItemSheet
        open={!!sheet && sheet.type === 'item'} item={sheet?.item} members={members} selfPubkey={selfPubkey} onClose={() => setSheet(null)}
        onSave={async (patch) => { await call('item:edit', { groupId: gid, listId: openListId, itemId: sheet.item.id, text: patch.text, qty: patch.qty, note: patch.note, url: patch.url }); await call('item:assign', { groupId: gid, listId: openListId, itemId: sheet.item.id, assignee: patch.assignee }); await loadItems(gid, openListId); setSheet(null) }}
        onDelete={async () => { await call('item:delete', { groupId: gid, listId: openListId, itemId: sheet.item.id }); await loadItems(gid, openListId); setSheet(null) }}
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
function SpaceSwitcherSheet ({ open, onClose, spaces, activeId, onPick, onCreate, onJoin, onDelete }) {
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
              ) : null}
            </div>
          )
        })}
      </div>
      <Button variant='secondary' onClick={onCreate}>Create a space</Button>
      <Button variant='secondary' style={{ marginTop: sp.sm }} onClick={onJoin}>Join a space</Button>
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
    try { await onJoin(v) } catch (e) { setBusy(false); alert('Could not join: ' + e.message) }
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

// A list row on the space overview. Tapping opens the list's detail.
function ListRow ({ list, members, onOpen }) {
  return (
    <button onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.base}px`, background: 'none', border: 'none', borderBottom: `1px solid ${c.divider}`, cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ flex: 1, minWidth: 0, color: c.text.primary, fontSize: 17, fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>
      <AssigneeAvatar pubkey={list.assignee} members={members} size={24} />
      <CaretRight size={18} color={c.text.muted} weight='regular' />
    </button>
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
function ComposerBar ({ value, onChange, onSubmit, placeholder, inputRef }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, display: 'flex', gap: sp.sm, padding: `${sp.sm}px ${sp.base}px calc(var(--pear-safe-bottom) + ${sp.sm}px)`, background: c.surface.base, borderTop: `1px solid ${c.border}` }}>
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }} placeholder={placeholder} style={{ flex: 1, padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none' }} />
      <button onClick={onSubmit} aria-label='Add' style={{ width: 46, borderRadius: r.md, border: 'none', background: c.primary, color: c.text.onPrimary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={22} weight='bold' /></button>
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

// List options (rename / assign / delete), opened from the detail header.
function ListOptionsSheet ({ open, list, members, onClose, onRename, onAssign, onDelete }) {
  if (!list) return null
  const Row = ({ onClick, danger, children }) => (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: danger ? c.error : c.text.primary, fontSize: 16, fontWeight: 300 }}>{children}</button>
  )
  return (
    <BottomSheet open={open} onClose={onClose} title={list.name}>
      <Row onClick={onRename}><span style={{ flex: 1, textAlign: 'left' }}>Rename list</span></Row>
      <Row onClick={onAssign}><span style={{ flex: 1, textAlign: 'left' }}>Assign to…</span><AssigneeAvatar pubkey={list.assignee} members={members} size={22} /></Row>
      <Row onClick={onDelete} danger><span style={{ flex: 1, textAlign: 'left' }}>Delete list</span></Row>
    </BottomSheet>
  )
}

function RenameListSheet ({ open, current, onClose, onSave }) {
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName(current || '') }, [open, current])
  return (
    <BottomSheet open={open} onClose={onClose} title='Rename list'>
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
    <div onClick={onClose} style={{ position: 'fixed', top: 'calc(var(--pear-safe-top) + 8px)', left: '50%', transform: 'translateX(-50%)', zIndex: 80, maxWidth: 560, width: 'calc(100% - 24px)', background: c.primary, color: c.text.onPrimary, padding: '10px 16px', borderRadius: r.lg, fontSize: 14, fontWeight: 400, textAlign: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', cursor: 'pointer' }}>{text}</div>
  )
}

// Who's in the space.
function MembersSheet ({ open, onClose, members, selfPubkey, spaceName }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={`In ${spaceName || 'this space'}`}>
      {members.length === 0
        ? <p style={{ color: c.text.muted, fontSize: 14, textAlign: 'center', padding: `${sp.base}px 0` }}>Just you so far.</p>
        : members.map((m) => (
            <div key={m.pubkey} style={{ display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.xs}px`, borderTop: `1px solid ${c.divider}` }}>
              <Avatar name={m.displayName} avatar={m.avatar} size={40} />
              <span style={{ color: c.text.primary, fontSize: 16 }}>{m.displayName || 'Member'}{m.pubkey === selfPubkey ? ' (You)' : ''}</span>
            </div>
          ))}
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

function MenuSheet ({ open, onClose, profile, onProfile, onAbout }) {
  const Row = ({ onClick, children }) => (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }}>{children}</button>
  )
  return (
    <BottomSheet open={open} onClose={onClose}>
      <button onClick={onProfile} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: sp.sm, width: '100%', padding: `${sp.xs}px ${sp.xs}px ${sp.base}px`, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'center' }}>
        <Avatar name={profile?.displayName} avatar={profile?.avatar} size={64} />
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ color: c.text.primary, fontSize: 17, fontWeight: 400 }}>{profile?.displayName || 'Set up profile'}</span>
          <span style={{ color: c.text.muted, fontSize: 13 }}>Name and photo</span>
        </span>
      </button>
      <Row onClick={onAbout}><span style={{ flex: 1 }}>About PearList</span><CaretRight size={16} color={c.text.muted} weight='regular' /></Row>
    </BottomSheet>
  )
}

function ProfileView ({ open, onBack, profile, theme, onTheme, onSaved }) {
  const fileRef = useRef(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setName(profile?.displayName || '') }, [open, profile])

  async function commitAvatar (value) {
    setBusy(true)
    try { await call('profile:set', { displayName: profile?.displayName || name.trim() || 'Me', avatar: value }); onSaved?.() }
    catch (e) { alert('Could not save photo: ' + e.message) } finally { setBusy(false) }
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
    } catch { alert('Could not read that image') }
  }
  async function saveName () {
    const trimmed = name.trim(); if (!trimmed) return
    setBusy(true)
    try { await call('profile:set', { displayName: trimmed }); onSaved?.() }
    catch (e) { alert('Could not save name: ' + e.message) } finally { setBusy(false) }
  }
  const hasAvatar = !!avatarSrc(profile?.avatar)
  const nameDirty = name.trim() && name.trim() !== profile?.displayName
  return (
    <FullScreen open={open} title='Profile' onBack={onBack}>
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

      <div style={{ background: c.surface.elevated, borderRadius: r.lg, padding: `${sp.xs}px ${sp.base}px` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${sp.md}px 0` }}>
          <span style={{ color: c.text.primary, fontSize: 16, fontWeight: 300 }}>Dark mode</span>
          <Toggle on={theme === 'dark'} onChange={(v) => onTheme(v ? 'dark' : 'light')} />
        </div>
      </div>
    </FullScreen>
  )
}

function AboutView ({ open, onBack, onWallet }) {
  const [section, setSection] = useState(null)
  const toggle = (id) => setSection((s) => s === id ? null : id)
  const ios = isIOS()
  async function donateBTC () {
    try { const r = await call('shell:canOpenURL', { url: 'lightning:test' }); if (r?.can) openUrl('lightning:' + LIGHTNING_ADDRESS); else onWallet() } catch { onWallet() }
  }
  const P = ({ children }) => <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, lineHeight: 1.5, margin: `0 0 ${sp.md}px` }}>{children}</p>
  const Pill = ({ onClick, children, primary }) => <button onClick={onClick} style={{ flex: 1, padding: '10px 12px', borderRadius: r.md, border: primary ? 'none' : `1px solid ${c.text.muted}`, background: primary ? c.primary : c.surface.input, color: primary ? c.text.onPrimary : c.text.primary, fontSize: 14, cursor: 'pointer' }}>{children}</button>
  return (
    <FullScreen open={open} title='About' onBack={onBack}>
      <div style={{ textAlign: 'center', marginBottom: sp.lg }}>
        <h2 style={{ fontSize: 22, fontWeight: 400, margin: 0, color: c.text.primary }}>PearList</h2>
        <p style={{ color: c.text.muted, fontSize: 14, marginTop: sp.xs }}>Private. Peer-to-Peer. No Servers.</p>
      </div>

      <Collapsible title='How it works' open={section === 'how'} onToggle={() => toggle('how')}>
        <P>PearList syncs your household's lists directly between devices using peer-to-peer technology powered by Hypercore Protocol. Your lists never touch a server - they live only on the devices in your household. No accounts. No subscriptions. No data collection.</P>
        <div style={{ display: 'flex' }}><Pill onClick={() => openUrl('https://pears.com/')}>Learn about P2P ↗</Pill></div>
      </Collapsible>

      {!ios && (
        <Collapsible title='Support development' open={section === 'support'} onToggle={() => toggle('support')}>
          <P>PearList is free and open source. If you receive value from it, please consider returning value.</P>
          <div style={{ display: 'flex', gap: sp.sm }}>
            <Pill primary onClick={donateBTC}>⚡ BTC ⚡</Pill>
            <Pill onClick={() => openUrl(BUYMEACOFFEE_URL)}>$ USD $</Pill>
          </div>
        </Collapsible>
      )}

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

function LightningWalletSheet ({ open, onClose }) {
  return (
    <BottomSheet open={open} onClose={onClose} title='⚡ Bitcoin Lightning ⚡'>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>No Lightning wallet was detected. To send a tip, install one of these wallets:</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.sm }}>
        {LIGHTNING_WALLETS.map((w) => (
          <button key={w.name} onClick={() => openUrl(w.url)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: sp.md, background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: c.text.primary, fontSize: 15, fontWeight: 400 }}>{w.name}</span>
              <span style={{ color: c.text.muted, fontSize: 13 }}>{w.desc}</span>
            </span>
            <span style={{ color: c.text.muted }}>↗</span>
          </button>
        ))}
      </div>
      <p style={{ textAlign: 'center', color: c.text.muted, fontSize: 13, marginTop: sp.base }}>After installing, return here and tap BTC again.</p>
    </BottomSheet>
  )
}

function ItemSheet ({ open, item, members, selfPubkey, onClose, onSave, onDelete }) {
  const [text, setText] = useState('')
  const [qty, setQty] = useState(1)
  const [assignee, setAssignee] = useState(null)
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  const [picking, setPicking] = useState(false)
  useEffect(() => { if (open && item) { setText(item.text || ''); setQty(item.qty || 1); setAssignee(item.assignee || null); setNote(item.note || ''); setUrl(item.url || ''); setPicking(false) } }, [open, item])
  if (!item) return null
  return (
    <>
      <BottomSheet open={open} onClose={onClose} title='Edit item'>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
          <Field value={text} onChange={setText} placeholder='Item' />
          <div style={{ display: 'flex', alignItems: 'center', gap: sp.md }}>
            <span style={{ color: c.text.secondary, fontSize: 14, width: 70 }}>Quantity</span>
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Minus size={18} weight='bold' /></button>
            <span style={{ fontFamily: MONO, fontSize: 16, color: c.text.primary, minWidth: 24, textAlign: 'center' }}>{qty}</span>
            <button onClick={() => setQty((q) => q + 1)} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={18} weight='bold' /></button>
          </div>
          <button onClick={() => setPicking(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: sp.md, padding: '12px 14px', background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, cursor: 'pointer' }}>
            <span style={{ color: c.text.secondary, fontSize: 14 }}>Assigned to</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: sp.sm, color: c.text.primary, fontSize: 15 }}>
              {assignee ? <AssigneeAvatar pubkey={assignee} members={members} size={22} /> : null}
              {memberLabel(members, assignee, selfPubkey)}
              <CaretRight size={16} color={c.text.muted} weight='regular' />
            </span>
          </button>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder='Notes (optional)' rows={2} maxLength={2000}
            style={{ width: '100%', padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, outline: 'none', resize: 'vertical', minHeight: 44 }} />
          <div style={{ display: 'flex', gap: sp.sm }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='Link (optional, e.g. store page)' inputMode='url' autoCapitalize='none' autoCorrect='off'
              style={{ flex: 1, minWidth: 0, padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 15, fontWeight: 300, fontFamily: FONT, outline: 'none' }} />
            {url.trim() ? <button onClick={() => openUrl(url.trim().match(/^https?:\/\//i) ? url.trim() : 'https://' + url.trim())} aria-label='Open link' style={{ width: 46, flexShrink: 0, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.accent, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LinkIcon /></button> : null}
          </div>
          <Button onClick={() => onSave({ text: text.trim(), qty, assignee, note: note.trim(), url: url.trim() })}>Save</Button>
          <Button variant='danger' onClick={onDelete}>Delete item</Button>
        </div>
      </BottomSheet>
      <AssigneePickerSheet open={picking} onClose={() => setPicking(false)} members={members} selfPubkey={selfPubkey} current={assignee} onPick={(pk) => setAssignee(pk)} />
    </>
  )
}
