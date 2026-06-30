import { useState, useEffect, useRef, useCallback } from 'react'
import { call, on, isMock } from './ipc.js'
import { colors as c, spacing as sp, radius as r, FONT, MONO, setTheme, loadTheme } from './theme.js'

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
  const [sheet, setSheet] = useState(null) // 'start' | 'join' | 'invite' | 'lists' | 'settings' | { type:'item', item }
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
        left={<IconButton label='Settings' onClick={() => setSheet('settings')}>≡</IconButton>}
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
      <SettingsSheet open={sheet === 'settings'} onClose={() => setSheet(null)} theme={theme} onTheme={applyTheme} onInvite={() => setSheet('invite')} householdName={household?.name} />
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
  return (
    <BottomSheet open={open} onClose={onClose} title='Join a household'>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp.md }}>
        <Field value={code} onChange={setCode} placeholder='Paste the invite code' autoFocus />
        <Button disabled={busy || !code.trim()} style={{ opacity: busy || !code.trim() ? 0.5 : 1 }} onClick={async () => { setBusy(true); try { await onJoin(code.trim()) } catch (e) { setBusy(false); alert('Could not join: ' + e.message) } }}>{busy ? 'Joining…' : 'Join'}</Button>
      </div>
    </BottomSheet>
  )
}

function InviteSheet ({ open, onClose, inviteKey }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (open) setCopied(false) }, [open])
  return (
    <BottomSheet open={open} onClose={onClose} title='Invite your household'>
      <p style={{ color: c.text.secondary, fontSize: 14, fontWeight: 300, textAlign: 'center', margin: `0 0 ${sp.base}px` }}>Share this code. Anyone with it can join and edit your lists.</p>
      <div style={{ background: c.surface.input, border: `1px solid ${c.border}`, borderRadius: r.md, padding: sp.md, fontFamily: MONO, fontSize: 13, color: c.text.primary, wordBreak: 'break-all', marginBottom: sp.md, maxHeight: 140, overflowY: 'auto' }}>{inviteKey || ''}</div>
      <Button onClick={async () => { try { await navigator.clipboard.writeText(inviteKey || ''); setCopied(true) } catch { setCopied(true) } }}>{copied ? 'Copied' : 'Copy code'}</Button>
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

function SettingsSheet ({ open, onClose, theme, onTheme, onInvite, householdName }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={householdName || 'Settings'}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${sp.md}px 0`, borderBottom: `1px solid ${c.divider}` }}>
        <span style={{ color: c.text.primary, fontSize: 16, fontWeight: 300 }}>Dark mode</span>
        <Toggle on={theme === 'dark'} onChange={(v) => onTheme(v ? 'dark' : 'light')} />
      </div>
      <button onClick={onInvite} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: `${sp.md}px 0`, background: 'none', border: 'none', cursor: 'pointer', color: c.text.primary, fontSize: 16, fontWeight: 300 }}>
        <span>Invite household</span><span style={{ color: c.text.muted }}>↗</span>
      </button>
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
