import { createRoot } from 'react-dom/client'
import { injectGlobalStyles, setTheme, loadTheme } from './theme.js'
import App from './App.jsx'

// Inject fonts + theme variables and apply the saved theme before first paint
// so there is no flash (matches the suite's boot order).
injectGlobalStyles()
setTheme(loadTheme())

createRoot(document.getElementById('root')).render(<App />)
