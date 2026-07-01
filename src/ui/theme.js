// PearList design tokens. Matches the PeerLoom suite (PearCircle/PearCal):
// Manrope, [data-theme] CSS variables, green accent, the shared spacing/radius
// scales. Body weight 300, headings 400, emphasis 500.

import { FONT_CSS } from './fonts.js'

export const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif"
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 }
export const radius = { sm: 4, md: 8, lg: 10, xl: 14, sheet: 20, full: 9999 }

const v = (n) => `var(--color-${n})`
export const colors = {
  primary: v('primary'), primaryDark: v('primary-dark'), accent: v('accent'),
  error: v('error'), warn: v('warn'), success: v('success'),
  text: { primary: v('text-primary'), secondary: v('text-secondary'), muted: v('text-muted'), onPrimary: v('text-on-primary') },
  surface: { base: v('surface-base'), card: v('surface-card'), elevated: v('surface-elevated'), input: v('surface-input') },
  border: v('border'), divider: v('divider'), track: v('track'),
}

// Dark is the default (plain :root), matching the suite.
const THEME_VARS = `
:root, :root[data-theme="dark"]{
  --color-primary:#9FE15A; --color-primary-dark:#5BAF3A; --color-accent:#7ec4cf;
  --color-error:#ef5350; --color-warn:#ffb74d; --color-success:#7ec77a;
  --color-text-primary:#f0f0f0; --color-text-secondary:#b0b0b0; --color-text-muted:#808080; --color-text-on-primary:#0a1f23;
  --color-surface-base:#0d0d0d; --color-surface-card:#1a1a1a; --color-surface-elevated:#252525; --color-surface-input:#1c1c1c;
  --color-border:#3a3a3a; --color-divider:#333333; --color-track:#4a4a4a;
}
:root[data-theme="light"]{
  --color-primary:#5BAF3A; --color-primary-dark:#3F8A26; --color-accent:#3a8a99;
  --color-error:#c62828; --color-warn:#b8730f; --color-success:#2e7d32;
  --color-text-primary:#1a1916; --color-text-secondary:#4a4a4a; --color-text-muted:#7a7568; --color-text-on-primary:#ffffff;
  --color-surface-base:#f7f5f0; --color-surface-card:#ffffff; --color-surface-elevated:#efece4; --color-surface-input:#f0ede8;
  --color-border:#cbc6b8; --color-divider:#dcd8cc; --color-track:#c2bdaf;
}`

const RESET = `
:root{--pear-safe-top:env(safe-area-inset-top,0px);--pear-safe-bottom:env(safe-area-inset-bottom,0px);--pear-safe-left:env(safe-area-inset-left,0px);--pear-safe-right:env(safe-area-inset-right,0px)}
*,*::before,*::after{box-sizing:border-box}
*{-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}
html,body,#root{height:100%;margin:0}
body{background:var(--color-surface-base);color:var(--color-text-primary);font-family:${FONT};font-weight:300;-webkit-font-smoothing:antialiased}
input,textarea{-webkit-user-select:text;user-select:text;font-size:16px;font-family:${FONT};font-weight:300}
button{font-family:${FONT};transition:transform 120ms cubic-bezier(0.2,0,0,1)}
button:active{transform:scale(0.97)}
@keyframes pearlist-spin{to{transform:rotate(360deg)}}
@keyframes pearlist-pop{0%{transform:scale(0.7)}60%{transform:scale(1.12)}100%{transform:scale(1)}}
`

export function injectGlobalStyles () {
  if (typeof document === 'undefined') return
  if (document.getElementById('pearlist-styles')) return
  const el = document.createElement('style')
  el.id = 'pearlist-styles'
  el.textContent = FONT_CSS + THEME_VARS + RESET
  document.head.appendChild(el)
}

const THEME_KEY = 'pearlist:theme'
export function setTheme (mode) {
  if (typeof document === 'undefined') return
  const m = mode === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', m)
  try { localStorage.setItem(THEME_KEY, m) } catch {}
}
export function loadTheme () {
  try { const s = localStorage.getItem(THEME_KEY); if (s === 'light' || s === 'dark') return s } catch {}
  return 'dark'
}
