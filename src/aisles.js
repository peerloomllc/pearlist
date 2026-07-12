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
  'Baking',
  'Condiments',
  'Snacks',
  'Beverages',
  'Alcohol',
  'Household',
  'Personal Care',
  'Pet',
  'Other',
]
const AISLE_SET = new Set(AISLES)
const FALLBACK = 'Other'

// Coerce any value to a known aisle, or null if it is not one. Used to sanitize
// a category before it is written by the CLASSIFIER (so a bad model reply can
// never introduce a phantom aisle that no peer knows how to group).
function normalizeAisle (x) {
  return (typeof x === 'string' && AISLE_SET.has(x)) ? x : null
}

// Clean a USER-typed custom aisle name (item-detail "New aisle"): collapse
// whitespace, trim, cap length; null if empty. The classifier never mints these
// - only an explicit user choice can - so an open string is safe here (unlike
// the model path, which stays locked to the built-in AISLES). A name equal to a
// built-in just merges into that built-in's section (same bucket key).
function sanitizeCustomAisle (x) {
  if (typeof x !== 'string') return null
  const s = x.replace(/\s+/g, ' ').trim().slice(0, 24)
  return s.length ? s : null
}

// The section a category belongs to: any non-empty label is its own section
// (built-in OR user-made); absent/blank falls back to 'Other'. Old app versions
// that predate custom aisles group an unknown label under 'Other' instead - a
// graceful, additive degradation.
function bucketOf (category) {
  return (typeof category === 'string' && category.trim()) ? category : FALLBACK
}

// Keyword -> aisle rules. Each entry is [aisle, [words...]]. Matching is
// whole-word / whole-phrase, case-insensitive. The LONGEST matching phrase wins
// (most specific), so "peanut butter" -> Pantry beats "butter" -> Dairy and
// "ice cream" -> Frozen beats "cream" -> Dairy, regardless of rule order; ties
// on length fall to the earlier rule. Intentionally modest: this is a fallback,
// not the star of the show.
// Each aisle lists generic words + common brand names (so popular brands hit
// this fast, accurate path instead of the slower/less-reliable LLM). Brands are
// chosen to be distinctive tokens - ambiguous everyday words (always, gain,
// life, secret, ...) are deliberately omitted to avoid false matches.
const RULES = [
  ['Frozen', ['frozen', 'ice cream', 'popsicle', 'pizza', 'fries', 'nuggets', 'digiorno', 'totinos', "totino's", 'hot pocket', 'hot pockets', 'eggo', 'ben & jerry', "ben & jerry's", 'haagen-dazs', 'haagen dazs', 'talenti', 'klondike', 'tater tots', 'bagel bites', 'popsicles']],
  ['Produce', ['apple', 'apples', 'banana', 'bananas', 'lettuce', 'spinach', 'kale', 'tomato', 'tomatoes', 'onion', 'onions', 'garlic', 'potato', 'potatoes', 'carrot', 'carrots', 'lemon', 'lemons', 'lime', 'limes', 'avocado', 'avocados', 'berries', 'strawberries', 'blueberries', 'grapes', 'cucumber', 'pepper', 'peppers', 'broccoli', 'celery', 'cilantro', 'parsley', 'mushroom', 'mushrooms', 'orange', 'oranges', 'salad']],
  ['Dairy & Eggs', ['milk', 'egg', 'eggs', 'butter', 'cheese', 'yogurt', 'yoghurt', 'cream', 'sour cream', 'cottage', 'chobani', 'yoplait', 'oikos', 'philadelphia', 'babybel', 'string cheese', 'half and half', 'creamer', 'kraft singles']],
  ['Meat & Seafood', ['chicken', 'beef', 'pork', 'bacon', 'sausage', 'turkey', 'ham', 'steak', 'fish', 'salmon', 'tuna', 'shrimp', 'ground', 'tyson', 'perdue', 'oscar mayer', 'hillshire', 'ball park', 'johnsonville', 'jimmy dean', 'hot dog', 'hot dogs']],
  ['Bakery', ['bread', 'bagel', 'bagels', 'bun', 'buns', 'roll', 'rolls', 'tortilla', 'tortillas', 'muffin', 'muffins', 'croissant', 'sourdough', 'baguette', 'cake', 'donut', 'donuts']],
  ['Beverages', ['water', 'juice', 'soda', 'coffee', 'tea', 'cola', 'seltzer', 'lemonade', 'kombucha', 'coke', 'coca-cola', 'coca cola', 'sprite', 'pepsi', 'dr pepper', 'mountain dew', 'mtn dew', 'gatorade', 'powerade', 'red bull', 'la croix', 'lacroix', 'snapple', 'capri sun', 'minute maid', 'tropicana', 'pellegrino', 'perrier', 'fanta', '7up', 'ginger ale', 'sunny d']],
  ['Alcohol', ['beer', 'wine', 'liquor', 'vodka', 'whiskey', 'whisky', 'bourbon', 'scotch', 'rum', 'tequila', 'gin', 'brandy', 'champagne', 'prosecco', 'sake', 'vermouth', 'hard cider', 'hard seltzer', 'white claw', 'ipa', 'lager', 'cocktail']],
  ['Snacks', ['chips', 'crackers', 'cookies', 'candy', 'chocolate', 'popcorn', 'pretzels', 'nuts', 'granola', 'bar', 'bars', 'snack', 'snacks', 'doritos', 'sunchips', 'sun chips', 'lays', "lay's", 'pringles', 'cheetos', 'ruffles', 'tostitos', 'fritos', 'oreo', 'oreos', 'chips ahoy', 'goldfish', 'ritz', 'cheez-it', 'cheez-its', 'cheezit', 'triscuit', 'wheat thins', 'skittles', 'snickers', 'kit kat', 'twix', "reese's", 'reeses', 'hershey', 'trail mix', 'pop tarts', 'pop-tarts', 'jerky', 'slim jim', 'clif bar', 'kind bar']],
  ['Pantry', ['rice', 'pasta', 'salt', 'oil', 'olive oil', 'vinegar', 'beans', 'lentils', 'cereal', 'oats', 'oatmeal', 'sauce', 'honey', 'peanut butter', 'jam', 'jelly', 'soup', 'broth', 'stock', 'spice', 'spices', 'coffee beans', 'can', 'canned', 'cheerios', 'corn flakes', 'cornflakes', 'frosted flakes', 'froot loops', 'lucky charms', 'raisin bran', 'rice krispies', 'quaker', "campbell's", 'campbells', 'chef boyardee', 'prego', 'ragu', 'nutella', 'ramen', 'maruchan', 'spam', 'velveeta']],
  ['Baking', ['flour', 'sugar', 'brown sugar', 'powdered sugar', 'baking soda', 'baking powder', 'yeast', 'vanilla', 'vanilla extract', 'cocoa', 'cocoa powder', 'chocolate chips', 'cake mix', 'brownie mix', 'frosting', 'sprinkles', 'shortening', 'molasses', 'corn starch', 'cornstarch', 'food coloring', 'condensed milk', 'evaporated milk', 'baking mix', 'bisquick', 'crisco']],
  ['Condiments', ['ketchup', 'mustard', 'mayo', 'mayonnaise', 'relish', 'hot sauce', 'soy sauce', 'bbq sauce', 'barbecue sauce', 'sriracha', 'salsa', 'salad dressing', 'ranch dressing', 'tabasco', 'worcestershire', 'teriyaki', 'pickles', 'olives', 'horseradish', 'tartar sauce', 'pesto', 'guacamole', 'hummus', 'heinz', "hellmann's", 'hellmanns']],
  ['Household', ['paper towel', 'paper towels', 'toilet paper', 'napkins', 'trash bags', 'detergent', 'soap', 'dish soap', 'sponge', 'sponges', 'bleach', 'cleaner', 'foil', 'wrap', 'ziploc', 'batteries', 'light bulb', 'bulbs', 'tide', 'clorox', 'lysol', 'bounty', 'charmin', 'cottonelle', 'febreze', 'windex', 'dawn', 'cascade', 'glad', 'hefty', 'swiffer', 'mr clean', 'pledge', 'brawny', 'angel soft', 'palmolive', 'comet', 'ajax']],
  ['Pet', ['cat food', 'dog food', 'puppy food', 'kitten food', 'pet food', 'kibble', 'cat litter', 'litter box', 'catnip', 'dog treats', 'cat treats', 'dog bone', 'rawhide', 'flea', 'purina', 'friskies', 'fancy feast', 'meow mix', 'iams', 'pedigree', 'blue buffalo', 'temptations', 'milk-bone', 'milk bone', 'tidy cats', 'greenies', 'sheba', 'whiskas', 'kibbles']],
  ['Personal Care', ['shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'razors', 'lotion', 'sunscreen', 'floss', 'tampons', 'pads', 'diapers', 'wipes', 'vitamins', 'ibuprofen', 'tylenol', 'bandaid', 'bandages', 'colgate', 'crest', 'sensodyne', 'listerine', 'olay', 'cetaphil', 'cerave', 'gillette', 'oral-b', 'oral b', 'tampax', 'kotex', 'huggies', 'pampers', 'luvs', 'band-aid', 'neosporin', 'advil', 'motrin', 'aleve', 'pepto', 'tums', 'centrum', 'dayquil', 'nyquil', 'purell', 'aveeno', 'chapstick', 'q-tips', 'qtips']],
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

module.exports = { AISLES, FALLBACK, normalizeAisle, sanitizeCustomAisle, bucketOf, classifyAisle, aisleOrder }
