import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import { call, on, isMock } from './ipc.js'
import { colors as c, spacing as sp, radius as r, FONT, MONO, setTheme, loadTheme } from './theme.js'

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

function initialsFor (label) {
  const s = (label || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase()
}
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

function Button ({ variant = 'primary', children, style, ...rest }) {
  const base = { width: '100%', padding: '14px 16px', borderRadius: r.lg, fontSize: 16, fontWeight: 400, cursor: 'pointer', fontFamily: FONT }
  const variants = {
    primary: { background: c.primary, color: c.text.onPrimary, border: 'none' },
    secondary: { background: c.surface.input, color: c.text.primary, border: `1px solid ${c.text.muted}` },
    danger: { background: 'transparent', color: c.error, border: `1px solid ${c.error}` },
  }
  return <button style={{ ...base, ...variants[variant], ...style }} {...rest}>{children}</button>
}

function IconButton ({ children, label, style, ...rest }) {
  return <button aria-label={label} style={{ width: 36, height: 36, padding: 0, background: 'none', color: c.text.secondary, border: 'none', fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }} {...rest}>{children}</button>
}

function TopBar ({ title, left, right }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `${sp.md}px ${sp.base}px`, borderBottom: `1px solid ${c.border}`, background: c.surface.base, position: 'sticky', top: 0, zIndex: 5 }}>
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 600, background: c.surface.card, borderRadius: `${r.sheet}px ${r.sheet}px 0 0`, maxHeight: '85dvh', overflowY: 'auto', transform: shown ? 'translateY(0)' : 'translateY(100%)', transition: 'transform 280ms cubic-bezier(0.32,0.72,0,1)', padding: `${sp.sm}px ${sp.lg}px calc(env(safe-area-inset-bottom, 0px) + ${sp.xl}px)` }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: c.text.muted, margin: '6px auto 14px' }} />
        {title ? <h2 style={{ textAlign: 'center', fontSize: 17, fontWeight: 400, margin: `0 0 ${sp.base}px`, color: c.text.primary }}>{title}</h2> : null}
        {children}
      </div>
    </div>
  )
}

function Toggle ({ on: isOn, onChange }) {
  return (
    <button onClick={() => onChange(!isOn)} aria-label='toggle' style={{ width: 44, height: 26, borderRadius: r.full, border: 'none', cursor: 'pointer', background: isOn ? c.primary : c.surface.elevated, position: 'relative', transition: 'background 160ms', padding: 0 }}>
      <span style={{ position: 'absolute', top: 3, left: isOn ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 160ms' }} />
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

// Accordion card matching the suite (rotating chevron, max-height body).
function Collapsible ({ title, open, onToggle, children }) {
  return (
    <div style={{ background: c.surface.elevated, borderRadius: r.lg, overflow: 'hidden', marginBottom: sp.sm }}>
      <button onClick={onToggle} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${sp.base}px`, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 400 }}>
        <span>{title}</span>
        <span style={{ fontSize: 18, color: c.text.muted, transition: 'transform 0.3s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>›</span>
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
      <header style={{ display: 'flex', alignItems: 'center', gap: sp.sm, padding: `${sp.md}px ${sp.base}px`, borderBottom: `1px solid ${c.border}` }}>
        <button onClick={onBack} aria-label='Back' style={{ width: 36, height: 36, background: 'none', border: 'none', color: c.text.secondary, fontSize: 28, cursor: 'pointer', lineHeight: 1 }}>‹</button>
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

function ItemRow ({ item, onToggle, onOpen }) {
  const checked = !!item.checked
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp.md, padding: `${sp.md}px ${sp.base}px`, borderBottom: `1px solid ${c.divider}` }}>
      <button onClick={() => onToggle(item)} aria-label={checked ? 'uncheck' : 'check'} style={{ width: 24, height: 24, flexShrink: 0, borderRadius: '50%', border: `2px solid ${checked ? c.primary : c.text.muted}`, background: checked ? c.primary : 'transparent', color: c.text.onPrimary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, padding: 0, animation: checked ? 'pearlist-pop 240ms ease' : 'none' }}>{checked ? '✓' : ''}</button>
      <button onClick={() => onOpen(item)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: sp.sm }}>
        <span style={{ position: 'relative', color: checked ? c.text.muted : c.text.primary, fontSize: 16, fontWeight: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.text}
          <span style={{ position: 'absolute', left: 0, right: 0, top: '52%', height: 2, background: c.primary, borderRadius: 2, transformOrigin: 'left', transform: checked ? 'scaleX(1)' : 'scaleX(0)', transition: 'transform 220ms cubic-bezier(0.32,0.72,0,1)' }} />
        </span>
        {item.qty > 1 ? <span style={{ fontFamily: MONO, fontSize: 12, color: c.text.secondary, background: c.surface.elevated, borderRadius: r.sm, padding: '1px 6px', flexShrink: 0 }}>×{item.qty}</span> : null}
      </button>
      <AssigneeChip name={item.assignee} />
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
        <p style={{ color: c.text.secondary, fontSize: 15, fontWeight: 300, marginTop: sp.sm }}>Shared lists for your household. No account, no server.</p>
      </div>
      <Button variant='primary' onClick={onStart}>Start a household</Button>
      <Button variant='secondary' onClick={onJoin}>Join with an invite</Button>
      {isMock ? <p style={{ textAlign: 'center', color: c.text.muted, fontSize: 12, marginTop: sp.base }}>preview mode (no peer sync)</p> : null}
    </div>
  )
}

export default function App () {
  const [phase, setPhase] = useState('loading')
  const [household, setHousehold] = useState(null)
  const [lists, setLists] = useState([])
  const [activeListId, setActiveListId] = useState(null)
  const [items, setItems] = useState([])
  const [theme, setThemeMode] = useState('dark')
  const [sheet, setSheet] = useState(null) // 'start'|'join'|'invite'|'lists'|'menu'|'wallet'|{type:'item',item}
  const [view, setView] = useState(null) // full-screen: 'profile' | 'about'
  const [profile, setProfile] = useState(null)
  const [donateReminder, setDonateReminder] = useState(false)
  const [draft, setDraft] = useState('')
  const composer = useRef(null)

  const gid = household?.groupId

  const loadLists = useCallback(async (groupId) => {
    const ls = await call('list:getAll', { groupId })
    setLists(ls)
    setActiveListId((cur) => cur && ls.some(l => l.id === cur) ? cur : (ls[0]?.id ?? null))
    return ls
  }, [])

  const loadItems = useCallback(async (groupId, listId) => {
    if (!groupId || !listId) { setItems([]); return }
    setItems(await call('item:getAll', { groupId, listId }))
  }, [])

  // Boot.
  useEffect(() => {
    setThemeMode(loadTheme())
    ;(async () => {
      await call('init', {})
      call('profile:get', {}).then(setProfile).catch(() => {})
      const h = await call('household:get', {})
      if (h) { setHousehold(h); await loadLists(h.groupId); setPhase('home') }
      else setPhase('onboarding')
    })().catch((e) => { console.error(e); setPhase('onboarding') })
  }, [loadLists])

  // Poll the active list so a peer's changes show up. Cheap for a list app.
  useEffect(() => {
    if (phase !== 'home' || !gid || !activeListId) return
    loadItems(gid, activeListId)
    const t = setInterval(() => loadItems(gid, activeListId), 2500)
    const off = on('peer:connected', () => { loadLists(gid); loadItems(gid, activeListId) })
    return () => { clearInterval(t); off() }
  }, [phase, gid, activeListId, loadItems, loadLists])

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

  const activeList = lists.find(l => l.id === activeListId) || null

  async function createHousehold (name) {
    const { groupId, inviteKey } = await call('group:create', { name })
    const h = { groupId, name: name || 'Household', inviteKey }
    setHousehold(h)
    // Seed a first list so the home screen is not empty.
    const { listId } = await call('list:create', { groupId, name: 'Groceries' })
    await loadLists(groupId); setActiveListId(listId)
    setPhase('home'); setSheet('invite')
  }
  async function joinHousehold (inviteKey) {
    const { groupId } = await call('group:join', { inviteKey })
    const h = await call('household:get', {}) || { groupId, name: 'Household', inviteKey }
    setHousehold(h); await loadLists(groupId); setPhase('home'); setSheet(null)
  }
  async function addItem () {
    const text = draft.trim(); if (!text || !gid || !activeListId) return
    setDraft('')
    await call('item:add', { groupId: gid, listId: activeListId, text })
    await loadItems(gid, activeListId)
    composer.current?.focus?.()
  }
  async function toggleItem (item) {
    setItems((cur) => cur.map(i => i.id === item.id ? { ...i, checked: !item.checked } : i)) // optimistic
    await call('item:toggle', { groupId: gid, listId: activeListId, itemId: item.id, checked: !item.checked })
    loadItems(gid, activeListId)
  }
  async function addList (name) {
    const { listId } = await call('list:create', { groupId: gid, name: name || 'New list' })
    await loadLists(gid); setActiveListId(listId); setSheet(null)
  }
  async function applyTheme (mode) { setTheme(mode); setThemeMode(mode) }

  if (phase === 'loading') {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={28} /></div>
  }
  if (phase === 'onboarding') {
    return (
      <>
        <Onboarding onStart={() => setSheet('start')} onJoin={() => setSheet('join')} />
        <StartSheet open={sheet === 'start'} onClose={() => setSheet(null)} onCreate={createHousehold} />
        <JoinSheet open={sheet === 'join'} onClose={() => setSheet(null)} onJoin={joinHousehold} />
      </>
    )
  }

  const remaining = items.filter(i => !i.checked).length
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', maxWidth: 600, margin: '0 auto' }}>
      <TopBar
        title={household?.name || 'Household'}
        left={<button aria-label='Menu' onClick={() => setSheet('menu')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}><Avatar name={profile?.displayName} avatar={profile?.avatar} size={30} /></button>}
        right={<IconButton label='Invite' onClick={() => setSheet('invite')}>↗</IconButton>}
      />

      <button onClick={() => setSheet('lists')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: sp.sm, padding: `${sp.md}px ${sp.base}px`, background: 'none', border: 'none', borderBottom: `1px solid ${c.divider}`, cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: sp.sm }}>
          <span style={{ fontSize: 17, fontWeight: 400, color: c.text.primary }}>{activeList?.name || 'No list'}</span>
          <span style={{ fontSize: 13, color: c.text.muted }}>{remaining} left</span>
        </span>
        <span style={{ color: c.text.muted, fontSize: 16 }}>▾</span>
      </button>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 80 }}>
        {items.length === 0
          ? <div style={{ textAlign: 'center', color: c.text.muted, fontSize: 15, padding: `${sp.xxxl}px ${sp.xl}px` }}>Nothing here yet. Add the first thing below.</div>
          : items.map((it) => <ItemRow key={it.id} item={it} onToggle={toggleItem} onOpen={(item) => setSheet({ type: 'item', item })} />)}
      </div>

      {activeList ? (
        <div style={{ position: 'sticky', bottom: 0, display: 'flex', gap: sp.sm, padding: `${sp.sm}px ${sp.base}px calc(env(safe-area-inset-bottom, 0px) + ${sp.sm}px)`, background: c.surface.base, borderTop: `1px solid ${c.border}` }}>
          <input ref={composer} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addItem() }} placeholder='Add an item' style={{ flex: 1, padding: '12px 14px', background: c.surface.input, color: c.text.primary, border: `1px solid ${c.border}`, borderRadius: r.md, fontSize: 16, outline: 'none' }} />
          <button onClick={addItem} aria-label='Add' style={{ width: 46, borderRadius: r.md, border: 'none', background: c.primary, color: c.text.onPrimary, fontSize: 24, cursor: 'pointer' }}>+</button>
        </div>
      ) : null}

      <InviteSheet open={sheet === 'invite'} onClose={() => setSheet(null)} inviteKey={household?.inviteKey} />
      <ListsSheet open={sheet === 'lists'} onClose={() => setSheet(null)} lists={lists} activeId={activeListId} onPick={(id) => { setActiveListId(id); setSheet(null) }} onAdd={addList} />
      <MenuSheet open={sheet === 'menu'} onClose={() => setSheet(null)} profile={profile}
        onProfile={() => { setSheet(null); setView('profile') }}
        onAbout={() => { setSheet(null); setView('about') }}
        onInvite={() => setSheet('invite')} />
      <ProfileView open={view === 'profile'} onBack={() => setView(null)} profile={profile} theme={theme} onTheme={applyTheme}
        onSaved={() => call('profile:get', {}).then(setProfile).catch(() => {})} />
      <AboutView open={view === 'about'} onBack={() => setView(null)} onWallet={() => setSheet('wallet')} />
      <LightningWalletSheet open={sheet === 'wallet'} onClose={() => setSheet(null)} />
      <DonationReminderModal open={donateReminder} onDismiss={() => setDonateReminder(false)} onDonate={() => { setDonateReminder(false); setView('about') }} />
      <ItemSheet
        open={!!sheet && sheet.type === 'item'} item={sheet?.item} onClose={() => setSheet(null)}
        onSave={async (patch) => { await call('item:edit', { groupId: gid, listId: activeListId, itemId: sheet.item.id, ...patch }); if ('assignee' in patch) await call('item:assign', { groupId: gid, listId: activeListId, itemId: sheet.item.id, assignee: patch.assignee }); await loadItems(gid, activeListId); setSheet(null) }}
        onDelete={async () => { await call('item:delete', { groupId: gid, listId: activeListId, itemId: sheet.item.id }); await loadItems(gid, activeListId); setSheet(null) }}
      />
    </div>
  )
}

// --- sheets ---------------------------------------------------------------

function StartSheet ({ open, onClose, onCreate }) {
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  return (
    <BottomSheet open={open} onClose={onClose} title='Name your household'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={name} onChange={setName} placeholder='e.g. The Nest' autoFocus onEnter={() => onCreate(name.trim() || 'Household')} />
        <Button onClick={() => onCreate(name.trim() || 'Household')}>Create</Button>
      </div>
    </BottomSheet>
  )
}

function JoinSheet ({ open, onClose, onJoin }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setCode(''); setBusy(false) } }, [open])
  const join = async (value) => {
    const v = (value ?? code).trim(); if (!v) return
    setBusy(true)
    try { await onJoin(v) } catch (e) { setBusy(false); alert('Could not join: ' + e.message) }
  }
  const scan = async () => { try { const res = await call('shell:scanQr', {}); if (res?.code) join(res.code) } catch {} }
  return (
    <BottomSheet open={open} onClose={onClose} title='Join a household'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={code} onChange={setCode} placeholder='Paste the invite code' autoFocus />
        <Button disabled={busy || !code.trim()} style={{ opacity: busy || !code.trim() ? 0.5 : 1 }} onClick={() => join()}>{busy ? 'Joining…' : 'Join'}</Button>
        <Button variant='secondary' onClick={scan}>Scan QR code</Button>
      </div>
    </BottomSheet>
  )
}

function InviteSheet ({ open, onClose, inviteKey }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (open) setCopied(false) }, [open])
  const copy = async () => { try { await navigator.clipboard.writeText(inviteKey || '') } catch {} setCopied(true) }
  const share = () => { try { call('shell:share', { title: 'PearList invite', text: 'Join my PearList:\n\n' + (inviteKey || '') }) } catch {} }
  return (
    <BottomSheet open={open} onClose={onClose} title='Invite peers'>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>Anyone with this can join and edit your lists. Show the QR to scan, or copy or send the code.</p>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: sp.base }}>
        {inviteKey ? <QrImage text={inviteKey} size={200} /> : null}
      </div>
      <div style={{ display: 'flex', gap: sp.sm }}>
        <Button variant='secondary' onClick={copy}>{copied ? 'Copied' : 'Copy code'}</Button>
        <Button onClick={share}>Share</Button>
      </div>
    </BottomSheet>
  )
}

function ListsSheet ({ open, onClose, lists, activeId, onPick, onAdd }) {
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  return (
    <BottomSheet open={open} onClose={onClose} title='Lists'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: sp.base }}>
        {lists.map((l) => (
          <button key={l.id} onClick={() => onPick(l.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${sp.md}px ${sp.sm}px`, background: l.id === activeId ? c.surface.elevated : 'none', border: 'none', borderRadius: r.md, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: l.id === activeId ? 400 : 300 }}>
            <span>{l.name}</span>{l.id === activeId ? <span style={{ color: c.primary }}>✓</span> : null}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: sp.sm }}>
        <Field value={name} onChange={setName} placeholder='New list' onEnter={() => name.trim() && onAdd(name.trim())} />
        <button onClick={() => name.trim() && onAdd(name.trim())} aria-label='Add list' style={{ width: 46, borderRadius: r.md, border: 'none', background: c.primary, color: c.text.onPrimary, fontSize: 24, cursor: 'pointer', flexShrink: 0 }}>+</button>
      </div>
    </BottomSheet>
  )
}

function MenuSheet ({ open, onClose, profile, onProfile, onAbout, onInvite }) {
  const Row = ({ onClick, children }) => (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.md}px ${sp.xs}px`, background: 'none', border: 'none', borderTop: `1px solid ${c.divider}`, cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }}>{children}</button>
  )
  return (
    <BottomSheet open={open} onClose={onClose}>
      <button onClick={onProfile} style={{ display: 'flex', alignItems: 'center', gap: sp.md, width: '100%', padding: `${sp.xs}px ${sp.xs}px ${sp.base}px`, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <Avatar name={profile?.displayName} avatar={profile?.avatar} size={48} />
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ color: c.text.primary, fontSize: 17, fontWeight: 400 }}>{profile?.displayName || 'Set up profile'}</span>
          <span style={{ color: c.text.muted, fontSize: 13 }}>Name and photo</span>
        </span>
      </button>
      <Row onClick={onInvite}><span style={{ flex: 1 }}>Invite peers</span><span style={{ color: c.text.muted }}>↗</span></Row>
      <Row onClick={onAbout}><span style={{ flex: 1 }}>About PearList</span><span style={{ color: c.text.muted }}>›</span></Row>
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
    try { const small = await compressToAvatar(await readFileDataUrl(file)); await commitAvatar(small) }
    catch { alert('Could not read that image') }
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
        <div style={{ fontSize: 36 }}>🍐</div>
        <h2 style={{ fontSize: 22, fontWeight: 400, margin: `${sp.xs}px 0 0`, color: c.text.primary }}>PearList</h2>
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

function ItemSheet ({ open, item, onClose, onSave, onDelete }) {
  const [text, setText] = useState('')
  const [qty, setQty] = useState(1)
  const [assignee, setAssignee] = useState('')
  useEffect(() => { if (open && item) { setText(item.text || ''); setQty(item.qty || 1); setAssignee(item.assignee || '') } }, [open, item])
  if (!item) return null
  return (
    <BottomSheet open={open} onClose={onClose} title='Edit item'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={text} onChange={setText} placeholder='Item' autoFocus />
        <div style={{ display: 'flex', alignItems: 'center', gap: sp.md }}>
          <span style={{ color: c.text.secondary, fontSize: 14, width: 70 }}>Quantity</span>
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, fontSize: 18, cursor: 'pointer' }}>−</button>
          <span style={{ fontFamily: MONO, fontSize: 16, color: c.text.primary, minWidth: 24, textAlign: 'center' }}>{qty}</span>
          <button onClick={() => setQty((q) => q + 1)} style={{ width: 36, height: 36, borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface.input, color: c.text.primary, fontSize: 18, cursor: 'pointer' }}>+</button>
        </div>
        <div>
          <span style={{ color: c.text.secondary, fontSize: 14 }}>Assigned to</span>
          <div style={{ marginTop: sp.sm }}><Field value={assignee} onChange={setAssignee} placeholder='Nobody' /></div>
        </div>
        <Button onClick={() => onSave({ text: text.trim(), qty, assignee: assignee.trim() || null })}>Save</Button>
        <Button variant='danger' onClick={onDelete}>Delete item</Button>
      </div>
    </BottomSheet>
  )
}
