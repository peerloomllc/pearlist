// PearList grocery-aisle taxonomy + the offline classifier.
//
// `classifyAisle` is a pure keyword lookup: deterministic, dependency-free,
// unit-testable, instant, and cheap enough to run on the lowest-end device. It
// is the WHOLE classifier - an on-device language model backed it up between
// 2026-07-11 and 2026-07-26 and was removed for measuring worse than this pass
// alone (see DECISIONS.md 2026-07-26). `classifyItem` in listMethods.js remains
// the seam if a smarter classifier ever earns its place.
//
// Design notes:
//   - `category` is an ADDITIVE, optional field on an item row. Old peers accept
//     and ignore it; a row without it just renders ungrouped. No merge change.
//   - Categorization is written as a normal signed op (see listMethods
//     ai:categorize), so ONE device categorizes and every peer receives the
//     result rather than each recomputing it.
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
// Each aisle lists generic words + common brand names. Brands are chosen to be
// distinctive tokens - ambiguous everyday words (always, gain, life, secret, ...)
// are deliberately omitted to avoid false matches.
//
// WIDENED 2026-07-26, roughly 2.5x. Measured against test/fixtures/aisle-items.json
// (80 items written the way people type them, before any of this was added), the
// table scored 41%, leaving 43 of 83 items in Other: it knew 'apple' but not
// 'zucchini', 'cheese' but not 'mozzarella', 'chicken' but not 'pepperoni'. The
// vocabulary here is the whole classifier now that the on-device model is gone
// (DECISIONS.md 2026-07-26), so the gap mattered more than it used to.
//
// TWO RULES WHEN ADDING TO THIS TABLE, both learned the hard way:
//  1. A FALSE MATCH IS WORSE THAN A MISS. An item in Other rests where the user
//     can drag it in one gesture; an item confidently filed into the wrong aisle
//     is not noticed until they are standing in the wrong part of the shop. So
//     genuinely ambiguous words stay OUT: bare 'corn' (fresh/canned/frozen are
//     three aisles), 'mint' (herb or sweet), 'rose' and 'port' (ordinary words
//     before they are wines), bare 'roast' (also how coffee is described).
//  2. NAME THE PHRASE WHEN A SINGLE WORD WOULD STEAL IT. Longest match wins and
//     ties go to the earlier aisle, so 'fish sauce' must be spelled out or 'fish'
//     takes it to Meat & Seafood, and 'hot chocolate' or 'chocolate' takes it to
//     Snacks. Every such pair below carries a comment saying what it is beating.
// Run `node scripts/aisle-accuracy.mjs` after any edit here.
const RULES = [
  ['Frozen', ['frozen', 'ice cream', 'popsicle', 'pizza', 'fries', 'nuggets', 'digiorno', 'totinos', "totino's", 'hot pocket', 'hot pockets', 'eggo', 'ben & jerry', "ben & jerry's", 'haagen-dazs', 'haagen dazs', 'talenti', 'klondike', 'tater tots', 'bagel bites', 'popsicles',
    // Added 2026-07-26 (see the widening note above the table).
    'waffles', 'sorbet', 'sherbet', 'gelato', 'frozen yogurt', 'ice cream bars', 'ice cream sandwiches', 'ice pops', 'freezer pops', 'ice cubes',
    'fish sticks', 'corn dogs', 'mozzarella sticks', 'pot pie', 'pot pies', 'tv dinner', 'frozen dinner', 'frozen burrito', 'frozen burritos']],
  ['Produce', ['apple', 'apples', 'banana', 'bananas', 'lettuce', 'spinach', 'kale', 'tomato', 'tomatoes', 'onion', 'onions', 'garlic', 'potato', 'potatoes', 'carrot', 'carrots', 'lemon', 'lemons', 'lime', 'limes', 'avocado', 'avocados', 'berries', 'strawberries', 'blueberries', 'grapes', 'cucumber', 'pepper', 'peppers', 'broccoli', 'celery', 'cilantro', 'parsley', 'mushroom', 'mushrooms', 'orange', 'oranges', 'salad',
    // Vegetables. 'corn' stays out on purpose: fresh, canned and frozen corn are
    // three different aisles and the bare word cannot tell them apart, so the
    // qualified phrases carry it instead ('corn on the cob' here, 'canned corn'
    // Pantry, 'frozen corn' Frozen).
    'zucchini', 'cauliflower', 'asparagus', 'cabbage', 'romaine', 'iceberg', 'arugula', 'brussels sprouts', 'green beans', 'snap peas', 'snow peas',
    'radish', 'radishes', 'beet', 'beets', 'turnip', 'turnips', 'parsnip', 'parsnips', 'squash', 'butternut squash', 'zucchinis',
    'sweet potato', 'sweet potatoes', 'yam', 'yams', 'corn on the cob', 'scallions', 'green onion', 'green onions', 'shallot', 'shallots', 'leek', 'leeks',
    'ginger', 'jalapeno', 'jalapenos', 'serrano', 'habanero', 'poblano', 'eggplant', 'artichoke', 'artichokes', 'okra', 'bok choy', 'fennel', 'endive',
    'collard greens', 'swiss chard', 'watercress', 'sprouts', 'coleslaw mix', 'salad mix', 'spring mix',
    // Fruit.
    'peach', 'peaches', 'pear', 'pears', 'plum', 'plums', 'nectarine', 'nectarines', 'apricot', 'apricots', 'mango', 'mangoes', 'mangos', 'papaya',
    'pineapple', 'cantaloupe', 'honeydew', 'watermelon', 'melon', 'kiwi', 'cherries', 'raspberries', 'blackberries', 'cranberries', 'pomegranate',
    'grapefruit', 'tangerine', 'tangerines', 'clementines', 'mandarin', 'mandarins', 'plantain', 'plantains', 'figs']],
  ['Dairy & Eggs', ['milk', 'egg', 'eggs', 'butter', 'cheese', 'yogurt', 'yoghurt', 'cream', 'sour cream', 'cottage', 'chobani', 'yoplait', 'oikos', 'philadelphia', 'babybel', 'string cheese', 'half and half', 'creamer', 'kraft singles',
    // Cheeses people name instead of writing "cheese". 'pepper jack' is two words
    // on purpose: 'pepper' alone is Produce and would win the tie otherwise.
    'cheddar', 'mozzarella', 'provolone', 'feta', 'parmesan', 'ricotta', 'gouda', 'brie', 'gruyere', 'asiago', 'havarti', 'muenster', 'mascarpone',
    'blue cheese', 'goat cheese', 'pepper jack', 'monterey jack', 'colby', 'queso fresco', 'cotija', 'halloumi', 'mexican blend', 'shredded cheese',
    // Milks, creams and the rest of the case.
    'buttermilk', 'whipping cream', 'heavy whipping cream', 'whipped cream', 'greek yogurt', 'kefir', 'ghee', 'margarine', 'egg whites', 'egg substitute',
    'oat milk', 'almond milk', 'soy milk', 'cashew milk', 'lactose free milk', 'chocolate milk', 'eggnog', 'crescent rolls', 'cookie dough']],
  ['Meat & Seafood', ['chicken', 'beef', 'pork', 'bacon', 'sausage', 'turkey', 'ham', 'steak', 'fish', 'salmon', 'tuna', 'shrimp', 'ground', 'tyson', 'perdue', 'oscar mayer', 'hillshire', 'ball park', 'johnsonville', 'jimmy dean', 'hot dog', 'hot dogs',
    // Cuts. Bare 'roast' stays out: it is also how coffee is described.
    'ribeye', 'sirloin', 'tenderloin', 'brisket', 'chuck roast', 'pot roast', 'roast beef', 'ribs', 'short ribs', 'wings', 'drumsticks', 'lamb', 'veal',
    // Deli. These are the items that used to land in Other most often.
    'deli meat', 'lunch meat', 'pepperoni', 'salami', 'prosciutto', 'pastrami', 'bologna', 'pancetta', 'chorizo', 'bratwurst', 'brats', 'kielbasa',
    // Seafood.
    'cod', 'tilapia', 'halibut', 'mahi mahi', 'trout', 'catfish', 'snapper', 'mussels', 'clams', 'oysters', 'scallops', 'crab', 'crab legs', 'lobster',
    'calamari', 'crawfish', 'imitation crab', 'fish fillet', 'fish fillets']],
  ['Bakery', ['bread', 'bagel', 'bagels', 'bun', 'buns', 'roll', 'rolls', 'tortilla', 'tortillas', 'muffin', 'muffins', 'croissant', 'sourdough', 'baguette', 'cake', 'donut', 'donuts',
    // Breads by name. 'pizza dough' is two words because 'pizza' alone is Frozen.
    'naan', 'pita', 'pita bread', 'flatbread', 'focaccia', 'ciabatta', 'brioche', 'rye bread', 'wheat bread', 'white bread', 'whole wheat bread',
    'hamburger buns', 'hot dog buns', 'dinner rolls', 'sub rolls', 'hoagie', 'english muffin', 'english muffins', 'breadsticks', 'pizza dough',
    // Sweet side of the counter. 'brownie mix' and 'cake mix' stay in Baking, and
    // beat these on length, so a mix does not get filed as a fresh bake.
    'biscuits', 'scone', 'scones', 'danish', 'pastry', 'pastries', 'cinnamon rolls', 'pie crust', 'pie shell', 'cupcakes', 'brownies', 'pie']],
  ['Beverages', ['water', 'juice', 'soda', 'coffee', 'tea', 'cola', 'seltzer', 'lemonade', 'kombucha', 'coke', 'coca-cola', 'coca cola', 'sprite', 'pepsi', 'dr pepper', 'mountain dew', 'mtn dew', 'gatorade', 'powerade', 'red bull', 'la croix', 'lacroix', 'snapple', 'capri sun', 'minute maid', 'tropicana', 'pellegrino', 'perrier', 'fanta', '7up', 'ginger ale', 'sunny d',
    // Juices lose to the fruit on their own ('apple juice' -> Produce, because
    // both are one word and Produce is listed first). Name the pairs.
    'apple juice', 'orange juice', 'grape juice', 'cranberry juice', 'pineapple juice', 'tomato juice',
    // 'beer' alone is Alcohol; root beer is not. ('lemon juice' is deliberately
    // absent - bottled for cooking it is Pantry, squeezed it is Produce, and
    // guessing either way would be worse than leaving it to the model.)
    'root beer',
    // 'hot chocolate' beats chocolate -> Snacks. 'chocolate milk' deliberately
    // sits in Dairy & Eggs instead, because that is the case it is sold from.
    'hot chocolate', 'hot cocoa', 'energy drink', 'energy drinks', 'sports drink', 'electrolyte', 'electrolyte powder', 'drink mix', 'coconut water',
    'sparkling water', 'mineral water', 'tonic water', 'club soda', 'ginger beer', 'cream soda', 'orange soda', 'grape soda',
    'iced tea', 'sweet tea', 'green tea', 'black tea', 'herbal tea', 'chai', 'matcha', 'espresso', 'cold brew', 'coffee pods', 'k cups', 'coffee filters',
    'smoothie', 'juice box', 'juice boxes', 'horchata']],
  ['Alcohol', ['beer', 'wine', 'liquor', 'vodka', 'whiskey', 'whisky', 'bourbon', 'scotch', 'rum', 'tequila', 'gin', 'brandy', 'champagne', 'prosecco', 'sake', 'vermouth', 'hard cider', 'hard seltzer', 'white claw', 'ipa', 'lager', 'cocktail',
    // Wine by varietal, which is how a list actually names it. 'rose wine' and
    // 'port wine' keep their second word: bare 'rose' and 'port' are ordinary
    // words and would match things that are not drinks.
    'chardonnay', 'pinot noir', 'pinot grigio', 'sauvignon blanc', 'cabernet', 'cabernet sauvignon', 'merlot', 'malbec', 'zinfandel', 'riesling',
    'moscato', 'shiraz', 'syrah', 'sangria', 'rose wine', 'port wine', 'white wine', 'red wine',
    // Beer styles and spirits. 'porter' is left out for the same reason as 'rose'.
    'six pack', 'craft beer', 'pilsner', 'stout', 'pale ale', 'wheat beer', 'malt liquor', 'mezcal', 'cognac', 'moonshine', 'triple sec', 'cointreau',
    'aperol', 'campari', 'bitters', 'margarita mix', 'bloody mary mix', 'wine cooler']],
  ['Snacks', ['chips', 'crackers', 'cookies', 'candy', 'chocolate', 'popcorn', 'pretzels', 'nuts', 'granola', 'bar', 'bars', 'snack', 'snacks', 'doritos', 'sunchips', 'sun chips', 'lays', "lay's", 'pringles', 'cheetos', 'ruffles', 'tostitos', 'fritos', 'oreo', 'oreos', 'chips ahoy', 'goldfish', 'ritz', 'cheez-it', 'cheez-its', 'cheezit', 'triscuit', 'wheat thins', 'skittles', 'snickers', 'kit kat', 'twix', "reese's", 'reeses', 'hershey', 'trail mix', 'pop tarts', 'pop-tarts', 'jerky', 'slim jim', 'clif bar', 'kind bar',
    // 'chips' loses to the vegetable/grain in front of it (potato -> Produce,
    // tortilla -> Bakery), so the everyday snacks need naming outright.
    'potato chips', 'tortilla chips', 'corn chips', 'pita chips', 'veggie chips', 'kettle chips',
    // Candy and sweets. 'mints' is safe where bare 'mint' is not: the herb.
    'gummy bears', 'gummies', 'gummy worms', 'sour candy', 'hard candy', 'lollipops', 'licorice', 'jelly beans', 'gum', 'chewing gum', 'mints',
    'breath mints', 'caramels', 'taffy', 'wafers', 'biscotti', 'shortbread', 'fig bars', 'snack cakes',
    // 'rice krispie treats' is three words, so it outranks the two-word cereal
    // 'rice krispies' -> Pantry. Same trick as the chips above.
    'rice krispie treats',
    // Savoury. Each of these loses a one-word tie without naming: 'beef jerky'
    // to beef -> Meat & Seafood, 'rice cakes' to rice -> Pantry, 'cheese puffs'
    // to cheese -> Dairy.
    'beef jerky', 'turkey jerky', 'meat sticks', 'rice cakes', 'cheese puffs', 'veggie straws', 'puffs', 'caramel corn', 'kettle corn',
    'animal crackers', 'graham crackers', 'saltines', 'oyster crackers', 'cheese crackers',
    // Nuts and seeds, which the bare 'nuts' rule only half covered.
    'peanuts', 'almonds', 'cashews', 'pistachios', 'walnuts', 'pecans', 'macadamia', 'mixed nuts', 'sunflower seeds', 'pumpkin seeds',
    // Bars. 'granola bars' and friends tie 'granola' -> Snacks anyway, but naming
    // them keeps the intent obvious to the next person editing this table.
    'protein bar', 'protein bars', 'energy bar', 'granola bars', 'breakfast bars', 'fruit snacks', 'fruit leather', 'fruit roll ups']],
  ['Pantry', ['rice', 'pasta', 'salt', 'oil', 'olive oil', 'vinegar', 'beans', 'lentils', 'cereal', 'oats', 'oatmeal', 'sauce', 'honey', 'peanut butter', 'jam', 'jelly', 'soup', 'broth', 'stock', 'spice', 'spices', 'coffee beans', 'can', 'canned', 'cheerios', 'corn flakes', 'cornflakes', 'frosted flakes', 'froot loops', 'lucky charms', 'raisin bran', 'rice krispies', 'quaker', "campbell's", 'campbells', 'chef boyardee', 'prego', 'ragu', 'nutella', 'ramen', 'maruchan', 'spam', 'velveeta',
    // Broths and stocks lose to the animal ('chicken broth' -> Meat & Seafood),
    // vinegars to the drink ('wine vinegar' -> Alcohol), egg noodles to the egg.
    'chicken broth', 'beef broth', 'vegetable broth', 'bone broth', 'chicken stock', 'beef stock', 'vegetable stock',
    'wine vinegar', 'red wine vinegar', 'rice vinegar', 'apple cider vinegar', 'balsamic vinegar',
    'egg noodles',
    // Grains and pasta shapes.
    'quinoa', 'couscous', 'barley', 'farro', 'bulgur', 'grits', 'polenta', 'cornmeal', 'masa', 'breadcrumbs', 'bread crumbs', 'panko',
    'noodles', 'spaghetti', 'macaroni', 'penne', 'lasagna', 'linguine', 'fettuccine', 'rigatoni', 'orzo', 'gnocchi', 'mac and cheese', 'muesli',
    // Legumes.
    'chickpeas', 'garbanzo', 'garbanzo beans', 'black beans', 'pinto beans', 'kidney beans', 'refried beans', 'navy beans', 'white beans', 'split peas',
    // Canned + jarred. Each of these loses to a one-word rule without naming:
    // 'tomato paste'/'tomato sauce' to tomato -> Produce, 'coconut milk' to
    // milk -> Dairy, 'canned corn' to nothing at all.
    'tomato paste', 'tomato sauce', 'tomato puree', 'crushed tomatoes', 'diced tomatoes', 'marinara', 'marinara sauce', 'pasta sauce', 'alfredo sauce',
    'pizza sauce', 'coconut milk', 'coconut cream', 'canned corn', 'canned beans', 'canned tuna', 'applesauce', 'pie filling',
    // Sweeteners and oils.
    'maple syrup', 'pancake syrup', 'syrup', 'agave', 'corn syrup', 'vegetable oil', 'canola oil', 'coconut oil', 'avocado oil', 'sesame oil', 'cooking spray',
    // Dry goods and the rest of the middle aisles.
    'raisins', 'dried cranberries', 'dried fruit', 'prunes', 'dates', 'bouillon', 'bouillon cubes', 'gravy', 'gravy mix', 'taco seasoning', 'seasoning',
    'pancake mix', 'cream of wheat', 'tahini', 'miso', 'curry paste', 'protein powder']],
  ['Baking', ['flour', 'sugar', 'brown sugar', 'powdered sugar', 'baking soda', 'baking powder', 'yeast', 'vanilla', 'vanilla extract', 'cocoa', 'cocoa powder', 'chocolate chips', 'cake mix', 'brownie mix', 'frosting', 'sprinkles', 'shortening', 'molasses', 'corn starch', 'cornstarch', 'food coloring', 'condensed milk', 'evaporated milk', 'baking mix', 'bisquick', 'crisco',
    // A baking-chocolate brand loses to 'chips' -> Snacks without this.
    'ghirardelli', 'ghirardelli chips', 'baking chocolate',
    // Flours and sugars by name.
    'almond flour', 'coconut flour', 'bread flour', 'cake flour', 'self rising flour', 'confectioners sugar', 'coconut sugar', 'stevia', 'sweetener',
    // Mixes and set-ups. 'jello' and 'pudding' sit with the gelatin and pudding
    // mixes in most stores, not with the desserts.
    'gelatin', 'jello', 'pudding', 'pudding mix', 'cream of tartar', 'white chocolate chips', 'butterscotch chips', 'marshmallow fluff',
    'graham cracker crust', 'icing', 'fondant', 'food dye', 'cake decorations',
    // Baking-aisle paper goods. 'parchment paper' beats nothing today but reads
    // as Household to a keyword eye, so it is named here deliberately.
    'cupcake liners', 'muffin liners', 'baking cups', 'parchment paper']],
  ['Condiments', ['ketchup', 'mustard', 'mayo', 'mayonnaise', 'relish', 'hot sauce', 'soy sauce', 'bbq sauce', 'barbecue sauce', 'sriracha', 'salsa', 'salad dressing', 'ranch dressing', 'tabasco', 'worcestershire', 'teriyaki', 'pickles', 'olives', 'horseradish', 'tartar sauce', 'pesto', 'guacamole', 'hummus', 'heinz', "hellmann's", 'hellmanns',
    // Dressings. 'blue cheese dressing' is three words so it beats the two-word
    // 'blue cheese' -> Dairy, and 'italian dressing' beats nothing at all today.
    'italian dressing', 'caesar dressing', 'blue cheese dressing', 'honey mustard', 'vinaigrette', 'balsamic vinaigrette', 'thousand island',
    'dijon', 'dijon mustard', 'yellow mustard', 'spicy mustard',
    // Jarred. 'banana peppers' and 'jalapeno slices' are named because both their
    // words are Produce, and the jarred thing is what a list means.
    'capers', 'pickle relish', 'dill pickles', 'banana peppers', 'pepperoncini', 'giardiniera', 'sauerkraut', 'kimchi', 'jalapeno slices',
    // Sauces. 'fish sauce' beats fish -> Meat & Seafood; the rest have no
    // competing rule and simply were not there.
    'fish sauce', 'oyster sauce', 'hoisin', 'hoisin sauce', 'ponzu', 'sweet chili sauce', 'chili garlic sauce', 'chili crisp', 'buffalo sauce',
    'wing sauce', 'cocktail sauce', 'steak sauce', 'a1 sauce', 'enchilada sauce', 'taco sauce', 'chimichurri', 'aioli', 'tzatziki', 'chutney', 'marinade',
    // Dips. Each beats a one-word rule: queso/ranch/onion have none, but
    // 'sour cream dip' must outrank 'sour cream' -> Dairy.
    'queso dip', 'french onion dip', 'ranch dip', 'sour cream dip', 'artichoke dip', 'buffalo chicken dip']],
  ['Household', ['paper towel', 'paper towels', 'toilet paper', 'napkins', 'trash bags', 'detergent', 'soap', 'dish soap', 'sponge', 'sponges', 'bleach', 'cleaner', 'foil', 'wrap', 'ziploc', 'batteries', 'light bulb', 'bulbs', 'tide', 'clorox', 'lysol', 'bounty', 'charmin', 'cottonelle', 'febreze', 'windex', 'dawn', 'cascade', 'glad', 'hefty', 'swiffer', 'mr clean', 'pledge', 'brawny', 'angel soft', 'palmolive', 'comet', 'ajax',
    // Cleaning brands that a single everyday word was swallowing:
    // 'Scotch-Brite' matched 'scotch' -> Alcohol, 'Bar Keepers Friend'
    // matched 'bar' -> Snacks. Both are two or more words, so they win.
    'scotch brite', 'bar keepers friend', 'bar keepers',
    // Laundry and dish. 'laundry soap' and the pods are named because bare 'soap'
    // is already Household but the two-word Personal Care soaps outrank it.
    'dryer sheets', 'fabric softener', 'laundry pods', 'laundry soap', 'laundry basket', 'stain remover',
    'dishwasher pods', 'dishwasher detergent', 'dishwasher tablets', 'rinse aid', 'dish towels',
    // Paper and disposables. 'disinfecting wipes' and 'cleaning wipes' must be
    // two words: bare 'wipes' is Personal Care (baby wipes).
    'paper plates', 'paper cups', 'plastic cups', 'plastic utensils', 'plastic forks', 'disposable plates', 'tissues', 'kleenex', 'facial tissues',
    'aluminum foil', 'plastic wrap', 'cling wrap', 'wax paper', 'freezer bags', 'sandwich bags', 'storage bags', 'garbage bags',
    'disinfecting wipes', 'cleaning wipes',
    // Cleaning tools and supplies.
    'rubber gloves', 'cleaning gloves', 'scrub brush', 'scouring pads', 'steel wool', 'mop', 'mop heads', 'broom', 'dustpan', 'vacuum bags',
    'toilet cleaner', 'toilet bowl cleaner', 'glass cleaner', 'all purpose cleaner', 'disinfectant', 'drain cleaner', 'oven cleaner', 'carpet cleaner',
    // Odds and ends that otherwise rest in Other.
    'air freshener', 'room spray', 'candles', 'matches', 'lighter', 'light bulbs', 'extension cord', 'duct tape', 'batteries aa', 'batteries aaa',
    'bug spray', 'insect spray', 'ant traps', 'mouse traps', 'water filter', 'water filters', 'hangers']],
  ['Pet', ['cat food', 'dog food', 'puppy food', 'kitten food', 'pet food', 'kibble', 'cat litter', 'litter box', 'catnip', 'dog treats', 'cat treats', 'dog bone', 'rawhide', 'flea', 'purina', 'friskies', 'fancy feast', 'meow mix', 'iams', 'pedigree', 'blue buffalo', 'temptations', 'milk-bone', 'milk bone', 'tidy cats', 'greenies', 'sheba', 'whiskas', 'kibbles',
    // Pet aisle beyond food. 'fish food' and 'pet wipes' need both words: 'fish'
    // alone is Meat & Seafood and 'wipes' alone is Personal Care.
    'dog leash', 'leash', 'dog collar', 'cat collar', 'collar', 'harness', 'dog toy', 'cat toy', 'pet toy', 'dog bed', 'cat bed', 'pet bed',
    'dog shampoo', 'pet shampoo', 'flea collar', 'flea treatment', 'dewormer', 'pet vitamins', 'pet wipes',
    'bird seed', 'birdseed', 'bird food', 'fish food', 'fish flakes', 'hamster food', 'rabbit food', 'guinea pig', 'aquarium', 'fish tank',
    'litter', 'litter liners', 'poop bags', 'waste bags', 'training pads', 'pee pads', 'puppy pads', 'scratching post', 'cat tree',
    'dog chews', 'bully sticks', 'pig ears', 'pet gate', 'pet carrier']],
  ['Personal Care', ['shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'razors', 'lotion', 'sunscreen', 'floss', 'tampons', 'pads', 'diapers', 'wipes', 'vitamins', 'ibuprofen', 'tylenol', 'bandaid', 'bandages', 'colgate', 'crest', 'sensodyne', 'listerine', 'olay', 'cetaphil', 'cerave', 'gillette', 'oral-b', 'oral b', 'tampax', 'kotex', 'huggies', 'pampers', 'luvs', 'band-aid', 'neosporin', 'advil', 'motrin', 'aleve', 'pepto', 'tums', 'centrum', 'dayquil', 'nyquil', 'purell', 'aveeno', 'chapstick', 'q-tips', 'qtips',
    // Personal Care is LAST in this table, so it loses every single-word tie:
    // 'bar soap' went to Snacks (via 'bar'), 'shaving cream' to Dairy & Eggs,
    // 'baby oil' to Pantry, 'Old Spice' to Pantry (via 'spice'). Two-word phrases
    // outrank single words, which is the only lever that does not reorder the
    // table and change everything else with it.
    'bar soap', 'hand soap', 'body soap', 'body wash', 'face wash', 'shaving cream', 'baby oil', 'bath salts',
    'old spice', 'hand sanitizer', 'cotton balls', 'nail polish', 'shower gel',
    // Medicine cabinet. 'cough drops' and 'ice pack' are two words on purpose:
    // 'drops' has no rule but 'ice' is Frozen and would take 'ice pack'.
    'cough drops', 'throat lozenges', 'lozenges', 'cough syrup', 'cold medicine', 'allergy medicine', 'allergy pills', 'nasal spray', 'eye drops',
    'antacid', 'laxative', 'stool softener', 'fiber supplement', 'hydrogen peroxide', 'rubbing alcohol', 'antibiotic ointment', 'hydrocortisone',
    'aloe', 'aloe vera', 'petroleum jelly', 'epsom salt', 'epsom salts', 'thermometer', 'heating pad', 'ice pack', 'gauze', 'medical tape',
    // Supplements.
    'melatonin', 'fish oil', 'omega 3', 'multivitamin', 'multivitamins', 'probiotics', 'magnesium', 'vitamin c', 'vitamin d', 'calcium', 'zinc', 'collagen',
    // Wash, hair and shave.
    'mouthwash', 'cotton swabs', 'cotton pads', 'cotton rounds', 'makeup remover', 'body lotion', 'hand lotion', 'face lotion', 'moisturizer',
    'face cream', 'eye cream', 'hair gel', 'hair spray', 'hairspray', 'dry shampoo', 'hair dye', 'hair color', 'hair ties', 'bobby pins', 'comb',
    'hairbrush', 'shaving gel', 'shaving foam', 'aftershave', 'razor blades', 'beard oil', 'nail clippers', 'nail file', 'nail polish remover', 'tweezers',
    'lip balm', 'lip gloss', 'sunblock', 'body spray', 'perfume', 'cologne', 'makeup', 'mascara', 'lipstick', 'acne cream', 'face mask',
    // Baby and feminine care, which sit with these in most stores.
    'baby wipes', 'baby lotion', 'baby powder', 'baby shampoo', 'diaper cream', 'pacifier', 'baby formula', 'formula',
    'panty liners', 'feminine wash', 'pregnancy test', 'condoms']],
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
