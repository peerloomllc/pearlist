// Refresh this app's copies of the sibling @peerloom packages (file: dependencies).
//
// `.npmrc` sets install-links=true, so npm copies ../peerloom-core and friends into
// node_modules instead of linking them. But npm does not copy them again while
// their version number is unchanged, so an edit to the sibling never reaches the
// app, here or on the Mac and Windows build machines that run `npm install` after
// syncing. This runs after every install and brings each copy in line with its
// sibling's files (leaving node_modules and .git alone).
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const deps = { ...pkg.dependencies, ...pkg.devDependencies }
const SKIP = new Set(['node_modules', '.git'])

function sync (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  const want = new Set()
  let changed = 0
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    want.add(e.name)
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) changed += sync(s, d)
    else if (e.isFile() && (!fs.existsSync(d) || !fs.readFileSync(d).equals(fs.readFileSync(s)))) { fs.copyFileSync(s, d); changed++ }
  }
  for (const e of fs.readdirSync(dst, { withFileTypes: true })) {
    if (SKIP.has(e.name) || want.has(e.name)) continue
    fs.rmSync(path.join(dst, e.name), { recursive: true, force: true })
    changed++
  }
  return changed
}

for (const [name, spec] of Object.entries(deps)) {
  if (!name.startsWith('@peerloom/') || typeof spec !== 'string' || !spec.startsWith('file:')) continue
  const src = path.resolve(root, spec.slice('file:'.length))
  const dst = path.join(root, 'node_modules', name)
  if (!fs.existsSync(src)) { console.warn('sync-peerloom-packages: no ' + src + ', keeping the installed ' + name); continue }
  const st = fs.lstatSync(dst, { throwIfNoEntry: false })
  if (st && st.isSymbolicLink()) continue // linked, already live
  const n = sync(src, dst)
  if (n) console.log('sync-peerloom-packages: refreshed ' + name + ' (' + n + ' file' + (n === 1 ? '' : 's') + ')')
}
