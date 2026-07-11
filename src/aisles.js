// PearList grocery-aisle taxonomy + the offline classifier.
//
// This is the SEAM for on-device AI (the QVAC spike, 2026-07-11). Today
// `classifyAisle` is a pure keyword lookup: deterministic, dependency-free,
// unit-testable, and cheap enough to run on the lowest-end device. When the
// QVAC llamacpp addon is proven to load on-device, the model plugs in at
// `classifyItem` in listMethods.js and this keyword pass stays as the offline
// fallback (low-capability devices, or a word the model has not seen). See
// pearlist DECISIONS.md 2026-07-11.
//
// Design notes:
//   - `category` is an ADDITIVE, optional field on an item row. Old peers accept
//     and ignore it; a row without it just renders ungrouped. No merge change.
//   - Categorization is written as a normal signed op (see listMethods
//     ai:categorize), so ONE capable device categorizes and every peer receives
//     the result. A phone that cannot run the model never has to.
//   - Aisle names are the display labels themselves (human-readable), so the UI
//     needs no separate label map, only this order.

// Canonical aisle order (also the UI section order). 'Other' is the catch-all
// and always sorts last.
const AISLES = [
  'Produce',
  'Dairy & Eggs',
  'Meat & Seafood',
  'Bakery',
  'Frozen',
  'Pantry',
  'Snacks',
  'Beverages',
  'Household',
  'Personal Care',
  'Other',
]
const AISLE_SET = new Set(AISLES)
const FALLBACK = 'Other'

// Coerce any value to a known aisle, or null if it is not one. Used to sanitize
// a category before it is written (so a bad model reply can never introduce a
// phantom aisle that no peer knows how to group).
function normalizeAisle (x) {
  return (typeof x === 'string' && AISLE_SET.has(x)) ? x : null
}

// Keyword -> aisle rules. Each entry is [aisle, [words...]]. Matching is
// whole-word / whole-phrase, case-insensitive. The LONGEST matching phrase wins
// (most specific), so "peanut butter" -> Pantry beats "butter" -> Dairy and
// "ice cream" -> Frozen beats "cream" -> Dairy, regardless of rule order; ties
// on length fall to the earlier rule. Intentionally modest: this is a fallback,
// not the star of the show.
const RULES = [
  ['Frozen', ['frozen', 'ice cream', 'popsicle', 'pizza', 'fries', 'nuggets']],
  ['Produce', ['apple', 'apples', 'banana', 'bananas', 'lettuce', 'spinach', 'kale', 'tomato', 'tomatoes', 'onion', 'onions', 'garlic', 'potato', 'potatoes', 'carrot', 'carrots', 'lemon', 'lemons', 'lime', 'limes', 'avocado', 'avocados', 'berries', 'strawberries', 'blueberries', 'grapes', 'cucumber', 'pepper', 'peppers', 'broccoli', 'celery', 'cilantro', 'parsley', 'mushroom', 'mushrooms', 'orange', 'oranges', 'salad']],
  ['Dairy & Eggs', ['milk', 'egg', 'eggs', 'butter', 'cheese', 'yogurt', 'yoghurt', 'cream', 'sour cream', 'cottage']],
  ['Meat & Seafood', ['chicken', 'beef', 'pork', 'bacon', 'sausage', 'turkey', 'ham', 'steak', 'fish', 'salmon', 'tuna', 'shrimp', 'ground']],
  ['Bakery', ['bread', 'bagel', 'bagels', 'bun', 'buns', 'roll', 'rolls', 'tortilla', 'tortillas', 'muffin', 'muffins', 'croissant', 'sourdough', 'baguette', 'cake', 'donut', 'donuts']],
  ['Beverages', ['water', 'juice', 'soda', 'coffee', 'tea', 'beer', 'wine', 'cola', 'seltzer', 'lemonade', 'kombucha']],
  ['Snacks', ['chips', 'crackers', 'cookies', 'candy', 'chocolate', 'popcorn', 'pretzels', 'nuts', 'granola', 'bar', 'bars', 'snack', 'snacks']],
  ['Pantry', ['rice', 'pasta', 'flour', 'sugar', 'salt', 'oil', 'olive oil', 'vinegar', 'beans', 'lentils', 'cereal', 'oats', 'oatmeal', 'sauce', 'ketchup', 'mustard', 'mayo', 'mayonnaise', 'honey', 'peanut butter', 'jam', 'jelly', 'soup', 'broth', 'stock', 'spice', 'spices', 'coffee beans', 'can', 'canned']],
  ['Household', ['paper towel', 'paper towels', 'toilet paper', 'napkins', 'trash bags', 'detergent', 'soap', 'dish soap', 'sponge', 'sponges', 'bleach', 'cleaner', 'foil', 'wrap', 'ziploc', 'batteries', 'light bulb', 'bulbs']],
  ['Personal Care', ['shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'razors', 'lotion', 'sunscreen', 'floss', 'tampons', 'pads', 'diapers', 'wipes', 'vitamins', 'ibuprofen', 'tylenol', 'bandaid', 'bandages']],
]

// Pre-split each rule's phrases into word arrays once, so classify is a cheap
// scan. Multi-word phrases ("ice cream", "peanut butter") match as a substring
// on word boundaries; single words match a whole token.
function tokenize (text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// Offline keyword classifier: returns a known aisle, or FALLBACK ('Other') if
// nothing matches. Never returns null (every item gets a bucket), so the
// categorize pass always terminates. Pure + synchronous by design.
function classifyAisle (text) {
  const t = ' ' + tokenize(text).join(' ') + ' '
  if (t.trim() === '') return FALLBACK
  let best = FALLBACK
  let bestLen = 0
  for (const [aisle, phrases] of RULES) {
    for (const p of phrases) {
      // whole-word / whole-phrase match, padded so "pear" != "spear"
      if (!t.includes(' ' + p + ' ')) continue
      const len = p.split(' ').length
      if (len > bestLen) { best = aisle; bestLen = len } // longest phrase = most specific
    }
  }
  return best
}

// Stable sort index for grouping (unknown -> last).
function aisleOrder (aisle) {
  const i = AISLES.indexOf(aisle)
  return i === -1 ? AISLES.length : i
}

module.exports = { AISLES, FALLBACK, normalizeAisle, classifyAisle, aisleOrder }
