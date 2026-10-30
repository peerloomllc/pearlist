// "All done pop-up" (GH #248): the sheet offered when the last item is checked can
// be turned off. It must stay on for anyone who never touches the setting.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.jsx'), 'utf8')

test('the setting reads as on when nothing is stored', () => {
  const src = app()
  assert.match(src, /function loadAllDone \(\) \{ try \{ return localStorage\.getItem\(ALL_DONE_KEY\) !== '0' \} catch \{ return true \} \}/)
})

test('the sheet opens only while the setting is on', () => {
  const src = app()
  const line = src.split('\n').find((l) => l.includes("setSheet('listComplete')"))
  assert.ok(line, 'the trigger is still there')
  assert.match(line, /if \(allDonePrompt && /)
})

test('the settings page and the sheet both carry the switch', () => {
  const src = app()
  const at = src.indexOf('function ProfileView ')
  const body = src.slice(at, src.indexOf('\nfunction ', at + 1))
  assert.match(body, /title='All done pop-up'/)
  assert.match(body, /ABOUT\['All done pop-up'\]/)
  const sheetAt = src.indexOf('function ListCompleteSheet ')
  const sheet = src.slice(sheetAt, src.indexOf('\nfunction ', sheetAt + 1))
  assert.match(sheet, /onClick=\{onStopShowing\}/)
})
