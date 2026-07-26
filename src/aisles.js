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
  ['Beverages', ['water', 'juice', 'soda', 'coffee', 'tea', 'cola', 'seltzer', 'lemonade', 'kombucha', 'coke', 'coca-cola', 'coca cola', 'sprite', 'pepsi', 'dr pepper', 'mountain dew', 'mtn dew', 'gatorade', 'powerade', 'red bull', 'la croix', 'lacroix', 'snapple', 'capri sun', 'minute maid', 'tropicana', 'pellegrino', 'perrier', 'fanta', '7up', 'ginger ale', 'sunny d',
    // Juices lose to the fruit on their own ('apple juice' -> Produce, because
    // both are one word and Produce is listed first). Name the pairs.
    'apple juice', 'orange juice', 'grape juice', 'cranberry juice', 'pineapple juice', 'tomato juice',
    // 'beer' alone is Alcohol; root beer is not. ('lemon juice' is deliberately
    // absent - bottled for cooking it is Pantry, squeezed it is Produce, and
    // guessing either way would be worse than leaving it to the model.)
    'root beer']],
  ['Alcohol', ['beer', 'wine', 'liquor', 'vodka', 'whiskey', 'whisky', 'bourbon', 'scotch', 'rum', 'tequila', 'gin', 'brandy', 'champagne', 'prosecco', 'sake', 'vermouth', 'hard cider', 'hard seltzer', 'white claw', 'ipa', 'lager', 'cocktail']],
  ['Snacks', ['chips', 'crackers', 'cookies', 'candy', 'chocolate', 'popcorn', 'pretzels', 'nuts', 'granola', 'bar', 'bars', 'snack', 'snacks', 'doritos', 'sunchips', 'sun chips', 'lays', "lay's", 'pringles', 'cheetos', 'ruffles', 'tostitos', 'fritos', 'oreo', 'oreos', 'chips ahoy', 'goldfish', 'ritz', 'cheez-it', 'cheez-its', 'cheezit', 'triscuit', 'wheat thins', 'skittles', 'snickers', 'kit kat', 'twix', "reese's", 'reeses', 'hershey', 'trail mix', 'pop tarts', 'pop-tarts', 'jerky', 'slim jim', 'clif bar', 'kind bar',
    // 'chips' loses to the vegetable/grain in front of it (potato -> Produce,
    // tortilla -> Bakery), so the everyday snacks need naming outright.
    'potato chips', 'tortilla chips', 'corn chips', 'pita chips', 'veggie chips', 'kettle chips']],
  ['Pantry', ['rice', 'pasta', 'salt', 'oil', 'olive oil', 'vinegar', 'beans', 'lentils', 'cereal', 'oats', 'oatmeal', 'sauce', 'honey', 'peanut butter', 'jam', 'jelly', 'soup', 'broth', 'stock', 'spice', 'spices', 'coffee beans', 'can', 'canned', 'cheerios', 'corn flakes', 'cornflakes', 'frosted flakes', 'froot loops', 'lucky charms', 'raisin bran', 'rice krispies', 'quaker', "campbell's", 'campbells', 'chef boyardee', 'prego', 'ragu', 'nutella', 'ramen', 'maruchan', 'spam', 'velveeta',
    // Broths and stocks lose to the animal ('chicken broth' -> Meat & Seafood),
    // vinegars to the drink ('wine vinegar' -> Alcohol), egg noodles to the egg.
    'chicken broth', 'beef broth', 'vegetable broth', 'bone broth', 'chicken stock', 'beef stock', 'vegetable stock',
    'wine vinegar', 'red wine vinegar', 'rice vinegar', 'apple cider vinegar', 'balsamic vinegar',
    'egg noodles']],
  ['Baking', ['flour', 'sugar', 'brown sugar', 'powdered sugar', 'baking soda', 'baking powder', 'yeast', 'vanilla', 'vanilla extract', 'cocoa', 'cocoa powder', 'chocolate chips', 'cake mix', 'brownie mix', 'frosting', 'sprinkles', 'shortening', 'molasses', 'corn starch', 'cornstarch', 'food coloring', 'condensed milk', 'evaporated milk', 'baking mix', 'bisquick', 'crisco',
    // A baking-chocolate brand loses to 'chips' -> Snacks without this.
    'ghirardelli', 'ghirardelli chips', 'baking chocolate']],
  ['Condiments', ['ketchup', 'mustard', 'mayo', 'mayonnaise', 'relish', 'hot sauce', 'soy sauce', 'bbq sauce', 'barbecue sauce', 'sriracha', 'salsa', 'salad dressing', 'ranch dressing', 'tabasco', 'worcestershire', 'teriyaki', 'pickles', 'olives', 'horseradish', 'tartar sauce', 'pesto', 'guacamole', 'hummus', 'heinz', "hellmann's", 'hellmanns']],
  ['Household', ['paper towel', 'paper towels', 'toilet paper', 'napkins', 'trash bags', 'detergent', 'soap', 'dish soap', 'sponge', 'sponges', 'bleach', 'cleaner', 'foil', 'wrap', 'ziploc', 'batteries', 'light bulb', 'bulbs', 'tide', 'clorox', 'lysol', 'bounty', 'charmin', 'cottonelle', 'febreze', 'windex', 'dawn', 'cascade', 'glad', 'hefty', 'swiffer', 'mr clean', 'pledge', 'brawny', 'angel soft', 'palmolive', 'comet', 'ajax',
    // Cleaning brands that a single everyday word was swallowing:
    // 'Scotch-Brite' matched 'scotch' -> Alcohol, 'Bar Keepers Friend'
    // matched 'bar' -> Snacks. Both are two or more words, so they win.
    'scotch brite', 'bar keepers friend', 'bar keepers']],
  ['Pet', ['cat food', 'dog food', 'puppy food', 'kitten food', 'pet food', 'kibble', 'cat litter', 'litter box', 'catnip', 'dog treats', 'cat treats', 'dog bone', 'rawhide', 'flea', 'purina', 'friskies', 'fancy feast', 'meow mix', 'iams', 'pedigree', 'blue buffalo', 'temptations', 'milk-bone', 'milk bone', 'tidy cats', 'greenies', 'sheba', 'whiskas', 'kibbles']],
  ['Personal Care', ['shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'razors', 'lotion', 'sunscreen', 'floss', 'tampons', 'pads', 'diapers', 'wipes', 'vitamins', 'ibuprofen', 'tylenol', 'bandaid', 'bandages', 'colgate', 'crest', 'sensodyne', 'listerine', 'olay', 'cetaphil', 'cerave', 'gillette', 'oral-b', 'oral b', 'tampax', 'kotex', 'huggies', 'pampers', 'luvs', 'band-aid', 'neosporin', 'advil', 'motrin', 'aleve', 'pepto', 'tums', 'centrum', 'dayquil', 'nyquil', 'purell', 'aveeno', 'chapstick', 'q-tips', 'qtips',
    // Personal Care is LAST in this table, so it loses every single-word tie:
    // 'bar soap' went to Snacks (via 'bar'), 'shaving cream' to Dairy & Eggs,
    // 'baby oil' to Pantry, 'Old Spice' to Pantry (via 'spice'). Two-word phrases
    // outrank single words, which is the only lever that does not reorder the
    // table and change everything else with it.
    'bar soap', 'hand soap', 'body soap', 'body wash', 'face wash', 'shaving cream', 'baby oil', 'bath salts',
    'old spice', 'hand sanitizer', 'cotton balls', 'nail polish', 'shower gel']],
]

// BRAND names, checked only when no product noun matched.
//
// Precedence matters and it is not a detail: "Mrs Meyers hand soap" must file by
// HAND SOAP, not by Mrs Meyers, because the noun is what the person is buying and
// the brand may sell across several aisles. Ranking brands equal with nouns broke
// exactly that case the moment these were added, since a two-word brand ties a
// two-word noun and the earlier aisle in the table wins on a coin toss of ordering.
//
// So: nouns first, brands as the fallback. A brand only decides when the item is
// nothing but a brand, which is precisely the case that used to fall through to the
// on-device model - seconds of work for an answer that was right about half the
// time. Every brand here is one the model no longer has to guess at.
//
// Deliberately ABSENT: brands that span aisles (Dove is soap and chocolate, Arm &
// Hammer is baking soda, detergent and cat litter) and brands that are everyday
// words (all, gain, secret, always, axe, method, life, native, honest). A false
// match is worse than a miss, because a miss just goes to the model.
const BRANDS = [
  ['Frozen', ['stouffers', 'ore-ida', 'ore ida', 'birds eye', 'marie callenders', 'healthy choice', 'lean cuisine', 'amys', 'red baron', 'tombstone', 'screamin sicilian', 'breyers', 'blue bell', 'halo top', 'magnum', 'drumstick', 'edys', 'dreyers']],
  ['Produce', ['dole', 'driscolls', 'driscoll', 'cuties', 'halos', 'earthbound', 'fresh express', 'taylor farms']],
  ['Dairy & Eggs', ['sargento', 'kerrygold', 'cabot', 'land o lakes', 'lucerne', 'horizon', 'organic valley', 'daisy', 'breakstone', 'egglands', 'egglands best', 'vital farms', 'happy egg', 'borden', 'laughing cow', 'boursin', 'galbani', 'polly-o', 'fage', 'siggis', 'noosa', 'activia', 'dannon', 'silk', 'oatly', 'almond breeze', 'califia', 'coffee mate', 'international delight']],
  ['Meat & Seafood', ['butterball', 'applegate', 'bar s', 'eckrich', 'nathans', 'foster farms', 'smithfield', 'land o frost', 'buddig', 'gortons', 'mrs pauls']],
  ['Bakery', ['kings hawaiian', 'sara lee', 'natures own', 'arnold', 'oroweat', 'daves killer bread', 'thomas english muffins', 'martins', 'wonder bread', 'entenmanns', 'bimbo', 'udis', 'canyon bakehouse']],
  ['Beverages', ['folgers', 'maxwell house', 'dunkin', 'starbucks', 'cafe bustelo', 'community coffee', 'spindrift', 'topo chico', 'poland spring', 'dasani', 'aquafina', 'essentia', 'smartwater', 'bai', 'celsius', 'liquid iv', 'body armor', 'bodyarmor', 'vitaminwater', 'lipton', 'tazo', 'bigelow', 'twinings', 'celestial seasonings', 'swiss miss', 'ocean spray', 'welchs', 'simply orange', 'naked juice', 'v8', 'arizona', 'crystal light', 'kool aid']],
  ['Alcohol', ['modelo', 'barefoot', 'yuengling', 'corona', 'budweiser', 'bud light', 'coors', 'miller lite', 'michelob', 'heineken', 'stella artois', 'guinness', 'blue moon', 'sam adams', 'sierra nevada', 'lagunitas', 'josh cellars', 'kim crawford', 'yellow tail', 'apothic', 'meiomi', 'la marca', 'titos', 'jack daniels', 'jim beam', 'makers mark', 'jameson', 'bacardi', 'captain morgan', 'smirnoff', 'absolut', 'grey goose', 'hennessy', 'patron', 'jose cuervo', 'truly', 'high noon']],
  ['Snacks', ['rxbar', 'clif', 'quest bar', 'nature valley', 'nutri grain', 'fig newtons', 'chex mix', 'gardettos', 'takis', 'popcorners', 'smartfood', 'skinny pop', 'utz', 'herrs', 'snyders', 'rold gold', 'combos', 'planters', 'blue diamond', 'wonderful pistachios', 'haribo', 'sour patch', 'starburst', 'm&ms', 'milky way', 'three musketeers', 'almond joy', 'york peppermint', 'junior mints', 'altoids', 'little debbie', 'hostess']],
  ['Pantry', ['progresso', 'swanson', 'knorr', 'better than bouillon', 'goya', 'rotel', 'hunts', 'contadina', 'muir glen', 'cento', 'barilla', 'ronzoni', 'de cecco', 'banza', 'annies', 'uncle bens', 'bens original', 'minute rice', 'near east', 'rice a roni', 'zatarains', 'idahoan', 'top ramen', 'cup noodles', 'spaghettios', 'dinty moore', 'manwich', 'bushs', 'van camps', 'old el paso', 'ortega', 'college inn', 'pacific foods', 'skippy', 'jif', 'peter pan', 'smuckers', 'kelloggs', 'general mills', 'honey bunches', 'special k', 'chex', 'grape nuts', 'kix', 'trix', 'cocoa puffs', 'cinnamon toast crunch', 'mccormick']],
  ['Baking', ['krusteaz', 'duncan hines', 'betty crocker', 'pillsbury', 'king arthur', 'gold medal', 'bobs red mill', 'toll house', 'domino sugar', 'imperial sugar', 'argo', 'clabber girl', 'rumford', 'fleischmanns', 'red star yeast', 'wilton']],
  ['Condiments', ['kikkoman', 'cholula', 'tapatio', 'valentina', 'franks red hot', 'dukes', 'kewpie', 'best foods', 'frenchs', 'grey poupon', 'guldens', 'sweet baby rays', 'kc masterpiece', 'stubbs', 'primal kitchen', 'sir kensingtons', 'newmans own', 'kens', 'hidden valley', 'wish bone', 'marzetti', 'litehouse', 'mt olive', 'vlasic', 'claussen', 'mezzetta']],
  ['Household', ['seventh generation', 'mrs meyers', 'simple green', 'pine sol', 'murphy oil', 'scrubbing bubbles', 'easy off', 'drano', 'liquid plumr', 'resolve', 'shout', 'oxiclean', 'downy', 'bounce', 'snuggle', 'purex', 'viva', 'sparkle', 'marcal', 'saran', 'reynolds']],
  ['Pet', ['fresh step', 'kong', 'worlds best', 'dr elseys', 'science diet', 'royal canin', 'taste of the wild', 'nutro', 'beneful', 'cesar', 'dentastix', 'nylabone', 'chuckit', 'frontline', 'seresto']],
  ['Personal Care', ['neutrogena', 'claritin', 'zyrtec', 'allegra', 'benadryl', 'mucinex', 'robitussin', 'delsym', 'sudafed', 'afrin', 'flonase', 'prilosec', 'pepcid', 'imodium', 'dramamine', 'midol', 'excedrin', 'bayer', 'suave', 'nivea', 'vaseline', 'eucerin', 'lubriderm', 'jergens', 'gold bond', 'dial', 'irish spring', 'safeguard', 'softsoap', 'degree', 'speed stick', 'right guard', 'schick', 'venus razor', 'harrys', 'scope', 'poise', 'stayfree', 'playtex']],
]

// Pre-split each rule's phrases into word arrays once, so classify is a cheap
// scan. Multi-word phrases ("ice cream", "peanut butter") match as a substring
// on word boundaries; single words match a whole token.
// Apostrophes are DROPPED, not turned into a space, so "King's Hawaiian" becomes
// "kings hawaiian" and matches the way anyone would write the keyword. Splitting on
// them instead ("king s hawaiian") is why several entries in these tables could
// never fire: "lay's", "campbell's", "hellmann's", "reese's", "totino's" and
// "ben & jerry's" were all dead the day they were written, saved only by their
// apostrophe-free twins sitting next to them.
function tokenize (text) {
  return String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// Both tables are normalized ONCE through the same tokenizer as the input, so a
// phrase can be written the natural way and still match. Done at module load: the
// classifier runs per item on every list render.
const normalize = (phrase) => tokenize(phrase).join(' ')
const normalized = (table) => table.map(([aisle, phrases]) => [aisle, phrases.map(normalize).filter(Boolean)])

// Best match within one table: longest phrase wins (most specific), ties fall to
// the earlier aisle. Returns FALLBACK when nothing matched.
function bestIn (table, t) {
  let best = FALLBACK
  let bestLen = 0
  for (const [aisle, phrases] of table) {
    for (const p of phrases) {
      // whole-word / whole-phrase match, padded so "pear" != "spear"
      if (!t.includes(' ' + p + ' ')) continue
      const len = p.split(' ').length
      if (len > bestLen) { best = aisle; bestLen = len } // longest phrase = most specific
    }
  }
  return best
}

// Offline keyword classifier: returns a known aisle, or FALLBACK ('Other') if
// nothing matches. Never returns null (every item gets a bucket), so the
// categorize pass always terminates. Pure + synchronous by design.
//
// NOUNS FIRST, BRANDS SECOND. "Mrs Meyers hand soap" files by hand soap, not by
// Mrs Meyers: the noun is what the person is buying, and a brand may sell across
// several aisles. A brand only decides when the item is nothing but a brand -
// which is exactly the case that used to fall through to the on-device model.
const NOUN_RULES = normalized(RULES)
const BRAND_RULES = normalized(BRANDS)

function classifyAisle (text) {
  const t = ' ' + tokenize(text).join(' ') + ' '
  if (t.trim() === '') return FALLBACK
  const byNoun = bestIn(NOUN_RULES, t)
  return byNoun === FALLBACK ? bestIn(BRAND_RULES, t) : byNoun
}

// Stable sort index for grouping (unknown -> last).
function aisleOrder (aisle) {
  const i = AISLES.indexOf(aisle)
  return i === -1 ? AISLES.length : i
}

module.exports = { AISLES, FALLBACK, normalizeAisle, sanitizeCustomAisle, bucketOf, classifyAisle, aisleOrder }
