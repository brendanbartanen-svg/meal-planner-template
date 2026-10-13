# Recipe images

One image per recipe, `recipes/images/<slug>.jpg` where `<slug>` is the recipe
filename without `.md` (`butter-chicken.md` → `butter-chicken.jpg`). Square,
1024 × 1024, JPEG quality 85 (~300–600 KB). The app discovers them by filename;
a recipe without one simply shows no picture. Nothing in the recipe frontmatter
points at the image.

## How they are made (since 2026-10-12)

AI-generated in ChatGPT's image model, not photographs of our cooking.

1. **Claude writes the prompt** from the recipe's `description`, Ingredients
   and Steps: what is in the bowl, how it is cooked (char, glaze, crust), the
   garnish, the serving vessel. Realistic editorial food photo, never an
   illustration; no text, labels, people or hands; square 1:1.
2. **Setting varies per recipe** so the library does not look like one shoot.
   Pick one of each and avoid repeating the previous recipe's picks:
   - angle: straight-down overhead · 45° · low three-quarter close-up
   - surface: worn light oak · charcoal slate · white marble · enamel tray · linen
   - light: soft window light from the left · warm late-afternoon from the right ·
     bright cool overcast · dim evening with a candle or lamp
   - vessel: stoneware bowl · matte black ceramic · cast iron · sheet pan ·
     shallow plate
   - one or two props tied to the dish (a lemon half, the sauce in a small dish,
     the raw herb, the skillet it came from) blurred at the edge of frame
3. **One ChatGPT chat per image.** Driven from Claude in Chrome: open
   https://chatgpt.com/, click the composer, type the prompt, confirm the text
   is in the box (a fresh chat drops text typed within ~2 s of load), send,
   wait ~60–90 s, open the image in the viewer, Download. Chrome saves a
   1254 × 1254 PNG to ~/Downloads under ChatGPT's own title.
4. **Resize and file:** `sips -s format jpeg -s formatOptions 85 -Z 1024 in.png
   --out recipes/images/<slug>.jpg`, then commit and push. The PNG is not kept.

## Prompts used

### butter-chicken
A shallow stoneware bowl of lightened butter chicken: bite-size broiler-charred chicken thigh pieces with dark blistered edges folded into a silky, glossy, orange-red spiced tomato-cream sauce, served over a bed of fluffy white basmati rice with the sauce pooling into the rice. A swirl of cream on top, scattered fresh cilantro leaves, a lemon wedge at the side. Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle, soft natural window light from the left, shallow depth of field. One plate on a worn light-oak table with a rumpled natural-linen napkin and a fork at the edge of frame. Muted warm tones, slightly matte, no harsh highlights. No text, no labels, no people, no hands. Square 1:1.

### harissa-salmon-sheet-pan
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A rimmed dark steel sheet pan lined with crinkled, scorched parchment, straight from the oven: four harissa-and-honey glazed salmon fillets with a deep red-orange glaze, caramelized and blistered at the edges, among roasted sweet-potato cubes dusted with smoked paprika and charred broccoli florets. A squeezed lemon half on the pan, a thin zigzag of lemony Greek yogurt across the salmon and vegetables. The pan sits on a dark charcoal slate countertop; a small ceramic dish of extra yogurt sauce and a folded striped grey tea towel at the corner of frame. Warm late-afternoon light raking in from the right, long soft shadows. Moody, slightly matte, no harsh highlights. No text, no labels, no people, no hands. Square 1:1.

### saag-crispy-tofu
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the bowl. A matte black ceramic bowl of saag with crispy tofu: a creamy, vivid dark-green, coarsely textured spinach saag spooned over fluffy white basmati rice, topped with large torn, irregular cubes of tofu with a craggy cornstarch crust fried deep golden-brown and charred at the ridges, clearly crisp. A few thin slices of green serrano chile, a lemon wedge, and a sprinkle of toasted cumin seeds on top. The bowl sits on a white marble counter beside a small brass spoon; a cast-iron skillet and a bunch of fresh spinach blurred in the background. Bright, cool, even daylight from a large window behind the camera, airy and clean. No text, no labels, no people, no hands. Square 1:1.

### ahi-tuna-bowls
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A wide stoneware bowl of sesame-seared ahi tuna: thick slices of tuna fanned across jasmine rice, each slice with a thin golden-brown crust of white and black sesame seeds and a deep ruby-red rare center, barely cooked. Beside the fish, a pile of thin quick-pickled cucumber rounds, a spoonful of glossy minced ginger-scallion sauce over the tuna, and a zigzag of pale-orange sriracha mayo. The bowl sits on a rumpled natural-linen cloth; a small dish of soy sauce and a pair of chopsticks at the edge of frame. Soft natural window light from the left, gentle shadows, clean and fresh. No text, no labels, no people, no hands. Square 1:1.

### blackstone-chicken-shawarma
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A shallow plate holding two open-faced chicken shawarma pitas: warm, blistered pita rounds piled with roughly chopped griddled chicken thigh, deeply charred and crusty at the edges, stained red-orange from a smoked-paprika yogurt marinade. Over the chicken, thick white garlic-yogurt sauce, bright pink quick-pickled red onion slivers, chopped tomato and cucumber salad, and torn parsley. The plate sits on a charcoal slate surface; a small bowl of extra garlic-yogurt sauce and a lemon half blurred at the edge. Dim evening light, a single warm lamp off to one side, deep shadows, intimate and moody. No text, no labels, no people, no hands. Square 1:1.

### blackstone-fish-tacos
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the food. Three fish tacos lined up on a shallow plate: doubled-up griddled corn tortillas with charred spots, each holding big flakes of chile-rubbed white fish with a deep red-brown spiced crust, a swipe of pale-orange chipotle-lime crema, charred green cabbage slaw with blackened edges and cilantro, and slices of avocado. The plate sits on a chipped white enamel tray; lime wedges and a small dish of the crema blurred at the edge of frame. Warm late-afternoon light raking in from the right, long soft shadows, golden and lively. No text, no labels, no people, no hands. Square 1:1.

### blackstone-garlic-shrimp
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A matte black ceramic bowl of griddled chile-garlic shrimp over rice: plump pink shrimp with charred spots, glistening in a red-flecked garlic butter with visible chili flakes and minced garlic, tumbled with charred zucchini half-moons, blistered strips of red and yellow bell pepper and softened red onion wedges, all over fluffy jasmine rice flecked with chopped parsley and a little lemon zest. The bowl sits on a worn light-oak table; a squeezed lemon half and the small pan of leftover chile butter at the edge of frame. Bright, cool, even overcast daylight, soft shadows, clean colors. No text, no labels, no people, no hands. Square 1:1.

### chana-masala-tadka
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A stoneware bowl of chana masala over basmati rice: whole chickpeas in a thick, deep rust-brown onion-tomato gravy, a few chickpeas smashed into it, with a glossy sheen of ghee breaking at the edges. Poured over the top, a sizzling tadka of golden-brown fried garlic slices and red chili flakes in ghee, pooling in small red-gold spots. A swirl of white Greek yogurt, chopped cilantro and a lemon wedge. The bowl sits on a white marble counter; a tiny pan of extra tadka and a scattering of cumin seeds blurred at the edge of frame. Soft natural window light from the left, gentle shadows. No text, no labels, no people, no hands. Square 1:1.

### chana-masala
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the bowl. A matte black ceramic bowl of chana masala: whole chickpeas in a thick, spiced tomato and golden-onion gravy with a reddish-orange hue, served over a mound of fluffy white basmati rice, with a generous spoonful of cool white cucumber raita at one side, flecked with grated cucumber and a dusting of ground cumin, and scattered fresh cilantro leaves. The bowl sits on a charcoal slate surface; a lemon half and a small bowl of extra raita blurred in the background. Dim evening light from a candle just out of frame, warm glow against deep shadow, cozy. No text, no labels, no people, no hands. Square 1:1.

### chicken-piccata
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A cast-iron skillet of chicken piccata: four flour-dredged boneless chicken thighs seared deep golden-brown, sitting in a glossy pale-yellow lemon-butter pan sauce studded with dark green capers, thin lemon slices and lemon zest, chopped parsley scattered over everything. Beside the skillet, a pile of roasted broccoli florets with charred, crisp edges on a small plate. The skillet rests on a rumpled natural-linen cloth; a half lemon and a small dish of capers at the edge of frame. Warm late-afternoon light from the right, long soft shadows, golden tones. No text, no labels, no people, no hands. Square 1:1.

### chicken-rice-bowl
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A stoneware bowl built with jasmine rice, sliced griddled chicken thigh with a dark soy-honey sear and caramelized edges, roasted broccoli florets with charred tips, a tangle of quick-pickled thin cucumber slices and shredded carrot, a zigzag of pale pink spicy yogurt drizzle, sliced scallions and toasted sesame seeds on top. The bowl sits on a worn light-oak table; a second bowl partly visible and a small dish of the pickled vegetables blurred at the edge of frame. Bright, cool, even overcast daylight, soft shadows, fresh and clean. No text, no labels, no people, no hands. Square 1:1.

### coconut-dill-salmon-green-beans-corn
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the platter. A long shallow white platter holding a whole baked salmon fillet, pale pink and just flaking, draped in a creamy white coconut-dill dressing flecked with chopped dill and lemon zest, its juices pooling around. Piled over and alongside it, a bright salad of blanched halved green beans, raw yellow corn kernels and halved red cherry tomatoes with more fresh dill. Lemon wedges at the side. The platter sits on a white marble counter; a bunch of fresh dill and an opened foil packet blurred at the edge of frame. Soft natural window light from the left, airy, summery. No text, no labels, no people, no hands. Square 1:1.

### coconut-fish-tomato-bake
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A rimmed sheet pan straight from the broiler: four white fish fillets, opaque and just tender with lightly browned tops, nestled among dozens of blistered, burst cherry tomatoes with charred skins, everything sitting in a creamy pale-yellow coconut-lime sauce stained with tomato juices. Scattered chopped cilantro, thin green serrano slices and lime wedges on the pan. Beside the pan, a bowl of steamed jasmine rice. The pan sits on a charcoal slate counter; a folded dark tea towel at the corner of frame. Dim evening kitchen light, a warm lamp from one side, deep shadows, moody. No text, no labels, no people, no hands. Square 1:1.

### cod-crazy-water
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A wide, shallow stoneware bowl of cod in acqua pazza: a thick white cod fillet, opaque and flaking, half-submerged in a loose, pale-red briny broth with burst halved cherry tomatoes, smashed green and purple olives, capers, slivers of garlic and shallot, chopped parsley and a sheen of green olive oil on the surface. A thick slice of grilled crusty bread with char marks propped at the edge of the bowl. The bowl sits on a rumpled natural-linen cloth; a lemon half and a glass of white wine blurred at the edge of frame. Bright, cool, even overcast daylight, soft and clean. No text, no labels, no people, no hands. Square 1:1.

### gochujang-glazed-chicken-thighs
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the food. A matte black ceramic plate: boneless chicken thighs with a deep mahogany sear, lacquered in a sticky, glossy red gochujang-honey glaze that catches the light, sliced and set over fluffy jasmine rice with the pan glaze spooned over, scattered sliced scallions and toasted sesame seeds. Beside it, a mound of cold smashed cucumber chunks, craggy and glistening with sesame oil, with sesame seeds and a pinch of chili flakes. The plate sits on a chipped white enamel tray; a small bowl of extra glaze blurred at the edge of frame. Warm late-afternoon light from the right, long shadows, rich and glossy. No text, no labels, no people, no hands. Square 1:1.

### goulash
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. An open enameled cast-iron Dutch oven of Hungarian-style goulash: large chunks of beef chuck braised spoon-tender in a thick, deep brick-red paprika gravy with soft chunks of yellow potato, pieces of red and green bell pepper and melted onion, a sheen of paprika-stained fat on the surface. A spoonful of white sour cream dolloped on top, just starting to melt. The pot sits on a worn light-oak table; a small bowl of more sour cream and a wooden spoon at the edge of frame. Dim evening light from a candle, warm glow against deep shadow, hearty and rustic. No text, no labels, no people, no hands. Square 1:1.

### greek-chicken-whipped-feta
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A large shallow white platter spread with a thick layer of creamy whipped feta, swooshed with a spoon, and piled on top with roasted lemon-oregano chicken thighs with golden, crisp edges, roasted strips of red and yellow bell pepper, charred red onion wedges, burst and caramelized cherry tomatoes and dark kalamata olives, all glistening with pan juices and olive oil, with a scatter of dried oregano and black pepper. The platter sits on a white marble counter; a lemon half and a warm pita blurred at the edge of frame. Soft natural window light from the left, bright Mediterranean feel. No text, no labels, no people, no hands. Square 1:1.

### harissa-shrimp-greens-feta
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the bowl. A stoneware bowl of harissa shrimp over rice: plump shrimp, pink and curled with charred, blistered edges, coated in a brick-red harissa-garlic marinade, tossed with wilted roasted chard leaves and tender stems, over white basmati rice. Topped with slices of avocado, crumbled white feta, chopped red onion, chopped cilantro and a lime wedge. The bowl sits on a charcoal slate surface; a second lime cut in half and a small dish of harissa paste blurred at the edge of frame. Bright, cool, even overcast daylight, clean soft shadows. No text, no labels, no people, no hands. Square 1:1.

### jamaican-braised-oxtail
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A matte black ceramic plate of Jamaican-style braised oxtail: three dark, glossy pieces of oxtail on the bone, meat falling away, in a rich, deep brown allspice-and-thyme gravy with pale butter beans and coins of carrot, sliced scallion scattered over. Beside it, a mound of coconut rice and peas, the rice tinted light brown with dark red kidney beans, and a pile of garlicky steamed shredded green cabbage with carrot matchsticks. The plate sits on a rumpled natural-linen cloth; a whole scotch bonnet pepper and sprigs of thyme at the edge of frame. Dim evening light from a warm lamp, deep shadows, rich and comforting. No text, no labels, no people, no hands. Square 1:1.

### kamado-tandoori-chicken
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A shallow white platter of charcoal-grilled tandoori-style chicken: sliced boneless chicken thighs with a red-orange yogurt-spice crust, deeply charred and blackened in spots from the grill, beside grilled zucchini planks, halved bell peppers and thick red onion rounds with dark grill marks. A charred lemon half, a small bowl of white cucumber raita flecked with mint, and a side of basmati rice. The platter sits on a chipped white enamel tray; a bunch of fresh mint and the other half of the charred lemon blurred at the edge of frame. Warm late-afternoon light from the right, long shadows, smoky summer-evening feel. No text, no labels, no people, no hands. Square 1:1.

### miso-honey-salmon-bok-choy
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the plate. A matte black ceramic plate: a skin-on salmon fillet broiled under a miso-honey glaze that has gone deep amber and lacquered with dark charred spots, flaking pink at the edge, set beside two halves of baby bok choy seared cut-side down to a deep char with bright green leaves, all over a bed of jasmine rice. Spooned over the fish and greens, a red chili-scallion oil with sliced scallions and chili flakes, a few raw scallion greens scattered on top, a lime wedge at the side. The plate sits on a worn light-oak table; a small bowl of the chili-scallion oil blurred at the edge of frame. Soft natural window light from the left, glossy highlights on the glaze. No text, no labels, no people, no hands. Square 1:1.

### paneer-tikka-masala
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A stoneware bowl of paneer tikka masala over basmati rice: cubes of paneer with blackened, blistered yogurt-marinade char on their edges, half-sunk in a creamy, glossy orange-red tomato gravy with a visible swirl of cream, a few green cardamom pods, chopped cilantro and a lemon wedge. The bowl sits on a white marble counter; a small dish of extra gravy and a scattering of cilantro leaves at the edge of frame. Bright, cool, even overcast daylight, clean and airy. No text, no labels, no people, no hands. Square 1:1.

### pot-roast
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. An open enameled cast-iron Dutch oven of pot roast: a large chuck roast braised dark brown and pulling apart into shreds at the edge, surrounded by big chunks of soft orange carrot, halved Yukon gold potatoes and collapsed onion wedges, sitting in a glossy, dark savory tomato-thyme jus, with bay leaves and thyme sprigs tucked in. The pot sits on a charcoal slate counter; a carving fork and a sprig of thyme at the edge of frame. Dim evening light from a candle or low lamp, warm glow against deep shadow, cozy and rustic. No text, no labels, no people, no hands. Square 1:1.

### red-lentil-dal
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the bowl. A stoneware bowl of red lentil dal over basmati rice: a creamy, golden-yellow turmeric dal, loose and porridge-like, with wilted dark spinach leaves folded through, and a tadka of golden ghee poured over the top with crackling cumin seeds, crisp golden garlic slices, red chili flakes and a dusting of smoked paprika, the ghee pooling in red-gold spots. Chopped cilantro and a lemon wedge. The bowl sits on a rumpled natural-linen cloth; a torn piece of blistered naan and a tiny pan of tadka blurred at the edge of frame. Warm late-afternoon light from the right, long soft shadows, golden. No text, no labels, no people, no hands. Square 1:1.

### red-lentil-soup
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A matte black ceramic bowl of Turkish red lentil soup: a smooth, thick orange-gold soup with some whole lentils and small dice of carrot showing, a spoon of white Greek yogurt in the center, a drizzle of smoky red chile oil with Aleppo pepper flakes swirled across the surface, chopped cilantro and a lemon wedge on the rim. Beside the bowl, a warm pita torn in half, puffed and blistered. The bowl sits on a chipped white enamel tray; a second lemon wedge and a small dish of chile oil at the edge of frame. Soft natural window light from the left, gentle shadows, simple and warm. No text, no labels, no people, no hands. Square 1:1.

### salmon-puttanesca-sheet-pan
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A rimmed sheet pan straight from the oven: four salmon fillets, roasted just pink and flaking, sitting on a bed of blistered, collapsed cherry tomatoes, halved dark kalamata olives, capers and slivers of golden garlic that have crushed into a chunky, briny red sauce with red chili flakes, chopped parsley scattered over, a squeezed lemon half on the pan. At the other end of the pan, halved baby gold potatoes roasted cut-side down to deep crispy brown. The pan sits on a worn light-oak table; a small bowl of capers at the edge of frame. Bright, cool, even overcast daylight, clean and fresh. No text, no labels, no people, no hands. Square 1:1.

### sous-vide-ny-strip
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the plate. A shallow plate: a NY strip steak sliced against the grain into thick slices, a perfect edge-to-edge rosy medium-rare pink inside with a dark, crusty hard-seared exterior, glistening with melted garlic-herb butter, a smashed garlic clove and a sprig of thyme resting on top, fanned over a pile of roasted broccoli florets with deeply charred, crisp edges. The slices are tipped onto their sides so the cut faces show a vivid, even rosy-pink interior from crust to crust, with no grey band. Flaky salt and cracked black pepper on the meat. The plate sits on a charcoal slate surface; a steak knife and a small dish of butter blurred at the edge of frame. Dim evening light from a single warm lamp, deep shadows, dramatic. No text, no labels, no people, no hands. Square 1:1.

### umami-shepherds-pie
Realistic editorial food photograph, not an illustration. Shot straight down from directly overhead. A wide cast-iron skillet of shepherd's pie fresh from the broiler: a top of mashed potato dragged into ridges and peaks, the peaks broiled deep golden-brown, with one wedge lifted out and set on a small plate beside the skillet to reveal the filling of browned ground beef, finely chopped browned mushrooms, diced carrot and green peas in a thick, dark, glossy gravy. The skillet sits on a white marble counter; a sprig of thyme and a serving spoon at the edge of frame. Warm late-afternoon light from the right, long soft shadows, homey. No text, no labels, no people, no hands. Square 1:1.

### white-bean-skillet
Realistic editorial food photograph, not an illustration. Shot from a 45-degree angle. A cast-iron skillet of Mediterranean white beans: creamy white cannellini beans in a thick, smoky, deep-red tomato sauce with slivers of garlic, wilted dark spinach leaves folded through, and large soft chunks of white feta nestled on top, just beginning to melt, with a drizzle of green olive oil, a pinch of red pepper flakes and a squeeze of lemon. Beside the skillet, warm pitas, puffed and blistered, one torn. The skillet rests on a rumpled natural-linen cloth; a lemon half at the edge of frame. Soft natural window light from the left, gentle shadows, rustic. No text, no labels, no people, no hands. Square 1:1.

### white-fish-salsa-verde
Realistic editorial food photograph, not an illustration. Shot from a low three-quarter angle, close to the plate. A shallow plate: a thick cod fillet pan-roasted to a deep golden crust on top, white and flaking beneath, spooned generously with a chunky, vivid green salsa verde of finely chopped parsley, capers and red Calabrian chili in olive oil, sitting over crispy smashed baby gold potatoes with craggy browned edges and long charred broccoli florets. A lemon wedge at the side. The plate sits on a chipped white enamel tray; a small bowl of extra salsa verde and a bunch of parsley blurred at the edge of frame. Bright, cool, even overcast daylight, clean and crisp. No text, no labels, no people, no hands. Square 1:1.
