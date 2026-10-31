// Tappable links in notes and items (src/links.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const { splitLinks, firstLink } = require('../src/links')

const links = (s) => splitLinks(s).filter((p) => p.href).map((p) => p.href)

test('finds http, https and www links, and joining the parts gives the text back', () => {
  const s = 'Recipe: https://example.com/a?b=1#c and www.shop.com/x then http://x.org.'
  assert.deepEqual(links(s), ['https://example.com/a?b=1#c', 'https://www.shop.com/x', 'http://x.org'])
  assert.equal(splitLinks(s).map((p) => p.text).join(''), s)
})

test('sentence punctuation after a link is not part of it', () => {
  for (const [s, want] of [
    ['see https://a.com.', 'https://a.com'],
    ['(https://a.com)', 'https://a.com'],
    ['"https://a.com",', 'https://a.com'],
    ['https://a.com/x!?', 'https://a.com/x'],
    ['https://en.wikipedia.org/wiki/Pear_(fruit)', 'https://en.wikipedia.org/wiki/Pear_(fruit)'],
    ['(see https://en.wikipedia.org/wiki/Pear_(fruit))', 'https://en.wikipedia.org/wiki/Pear_(fruit)'],
  ]) assert.deepEqual(links(s), [want], s)
})

test('no links, empty input and bare prefixes give plain text only', () => {
  assert.deepEqual(splitLinks(''), [])
  assert.deepEqual(splitLinks(null), [])
  assert.deepEqual(splitLinks('milk, eggs, bread'), [{ text: 'milk, eggs, bread' }])
  assert.deepEqual(links('http:// and www. alone'), [])
  assert.deepEqual(links('notawww.site.com'), [])
})

test('lines and spacing around links are kept exactly', () => {
  const s = 'a\nhttps://a.com\n\n  www.b.com  \n'
  assert.equal(splitLinks(s).map((p) => p.text).join(''), s)
  assert.deepEqual(links(s), ['https://a.com', 'https://www.b.com'])
})

test('firstLink looks through each text in turn', () => {
  assert.equal(firstLink('Milk', 'from www.farm.com today'), 'https://www.farm.com')
  assert.equal(firstLink('https://a.com', 'https://b.com'), 'https://a.com')
  assert.equal(firstLink('Milk', undefined, ''), null)
})
