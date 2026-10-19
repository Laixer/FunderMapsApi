// Chapter "Funderingsrisico" (FoundationRiskChapter.vue + RiskNextSteps.vue) on the CSS model of lib.typ
// (px-type: 12 px Greycliff on 18 px lines; every gap is the Tailwind class of the Vue template):
//   section space-y-7 (28 px) · risk block space-y-5 (20) · row + text space-y-2 (8) · paragraphs space-y-4 (16)
//   RiskNextSteps: border-t grey-200, pt-3 (12), space-y-2 (8) · drawings grid-cols-2 gap-4, figure space-y-1 (4)
// The neighbourhood pie that closes the chapter is risk-pie() in back.typ.
#import "../lib.typ": *
// para: Chromium's line breaks (glyph advances rounded to whole px), from the back half
#import "../lib-back.typ": para

// One risk row: dl.list--definition in .risk (items-center), 24 px line with the baseline 16 px down;
// two col-span-6 halves of a 12-column grid with gap-4 (16 px); in each half the items are 12 px apart (gap-3).
#let risk-row(name, level, reliability) = txt({
  set text(top-edge: 16 * px, bottom-edge: -8 * px)
  grid(columns: (1fr, 1fr), column-gutter: 16 * px,
    grid(columns: (auto, auto, auto), column-gutter: 12 * px, align: horizon,
      box(height: 24 * px, align(horizon, image("/assets/icons/risk-" + level + ".svg", width: 16 * px, height: 16 * px))),
      name,
      text(fill: ink, risk-label.at(level)),
    ),
    grid(columns: (auto, auto), column-gutter: 12 * px,
      "Betrouwbaarheid",
      text(fill: ink, reliability-label.at(reliability, default: "-")),
    ),
  )
})

// The explanation: paragraphs 16 px apart, text-grey-700 (prints #3e4550)
#let paragraphs(..ps) = txt(text(fill: ink, {
  for (i, p) in ps.pos().enumerate() {
    if i > 0 { v(16 * px) }
    // the text box starts text-dx into the column, so it is that much narrower (699.7 px, as in the back half);
    // a line of exactly 700 px then wraps, as Chromium wraps it
    if type(p) == str { pad(right: text-dx, para(p, fill: ink)) } else { block(p) }
  }
}))

// RiskNextSteps.vue: the advice scales with the class.
#let next-steps(level) = {
  let tone = if level in ("a", "b") { "low" } else if level == "c" { "medium" } else { "high" }
  block(width: 100%, stroke: (top: 1 * px + grey-200), inset: (top: 1 * px + 12 * px), {
    txt(text(fill: grey-800, strong("Volgende stappen")))
    v(8 * px)
    paragraphs(if tone == "low" {
      (if level == "a" { "Er is geen verhoogd risico." } else { "Het risico is laag." }) + " Een aanvullend onderzoek is op dit moment meestal niet nodig. Houd het pand wel in de gaten op zichtbare signalen – scheurvorming, klemmende ramen of deuren, zichtbare verzakkingen – en raadpleeg dit rapport opnieuw als die zich voordoen of bij een ingrijpende verbouwing."
    } else if tone == "medium" { "Het risico is verhoogd. Acute maatregelen zijn nu meestal nog niet nodig, maar het is verstandig om alert te blijven op zichtbare signalen (scheurvorming, vocht, scheefstand). Bij twijfel – of bij verkoop of verbouwing van het pand – is een KCAF QuickScan een goede vervolgstap (zie hoofdstuk ‘Aanvullend onderzoek’)." } else [
      Het risico is hoog. Wij adviseren een #strong[KCAF QuickScan] als vervolgstap – een
      relatief snelle en betaalbare beoordeling die uitwijst of aanvullend funderingsonderzoek op
      locatie nodig is (zie hoofdstuk ‘Aanvullend onderzoek’). Bij zichtbare schade aan de gevel of
      constructie is een specialistisch funderingsonderzoek aangewezen.
    ])
  })
}

// One risk block (.risk, break-inside-avoid, space-y-5): row + text (space-y-2), then the advice
#let risk-block(name, level, reliability, texts, steps: true) = block(breakable: false, width: 100%, {
  risk-row(name, level, reliability)
  v(8 * px)
  paragraphs(..texts)
  if steps {
    v(20 * px)
    next-steps(level)
  }
})

// A drawing with its caption: figure space-y-1, figcaption font-bold leading-4 (16 px line) centred
#let drawing(file, caption) = block(breakable: false, width: 100%, {
  image(file, width: 100%)
  v(4 * px)
  // leading-4: a 16 px line, so the ExtraBold baseline sits 1 px higher than on the 18 px lines of px-type
  show strong: set text(top-edge: 11 * px, bottom-edge: -5 * px)
  align(center, txt(text(fill: ink, strong(caption))))
})

#let risk-chapter(a) = {
  let dry = a.drystand_risk
  let wet = a.dewatering_depth_risk
  let bio = a.bio_infection_risk
  let blocks = ()
  // No list of risk types here: which ones follow depends on the pand's foundation type.
  blocks.push(paragraphs("Hieronder vindt u een beoordeling per risicotype dat voor het funderingstype van uw pand van toepassing is. Elk risico wordt afzonderlijk gewogen op basis van de beschikbare gegevens en kan verschillende oorzaken hebben – een laag risico op het ene type sluit een hoger risico op een ander niet uit.", "Bij elk risico staat een categorie van A (laagste) tot E (hoogste) en een betrouwbaarheid (Vastgesteld, Afgeleid of Indicatief). Zie het hoofdstuk ‘Hoe leest u dit rapport?’ voor de uitleg van beide. Onderaan dit hoofdstuk ziet u hoe uw pand zich verhoudt tot de panden in uw wijk."))
  if dry != none {
    blocks.push(risk-block("Droogstand", dry, a.drystand_risk_reliability, ("Bij droogstand (ook wel paalrot genoemd) komt het hoogstgelegen deel van het funderingshout (regelmatig) boven de grondwaterspiegel te liggen. Hierdoor kan zuurstof toetreden, wat leidt tot houtrot. Na jarenlange droogstand kan het draagvermogen van de fundering zijn aangetast, met als gevolg dat het pand vervormt. In een vergevorderd stadium uit zich dit in scheurvorming in de gevel, klemmende ramen en deuren, en zichtbare verzakkingen in het gevelaanzicht.",)))
  }
  // Optrekkend vocht and Verschilzakking share one source (the dewatering depth): one "Volgende stappen", at the end.
  if wet != none {
    blocks.push(risk-block("Optrekkend vocht", wet, a.dewatering_depth_risk_reliability, steps: false, ("Wanneer de grondwaterstand langdurig hoog is en zich dicht bij de fundering bevindt, ontstaat het risico op optrekkend vocht. Via poreuze bouwmaterialen – zoals bakstenen en metselmortel – wordt vocht opgenomen en trekt het omhoog in de constructie. Dit kan leiden tot schimmelvorming op muren en vloeren. Naast mogelijke gezondheidsklachten kan langdurige vochtbelasting ook leiden tot aantasting van bouwmaterialen, wat de constructieve staat van het pand verzwakt.", "Bij een hoge grondwaterstand kan bovendien water in de kruipruimte blijven staan, wat de luchtvochtigheid verhoogt en daarmee de kans op schimmel en houtrot verder vergroot.")))
    blocks.push(risk-block("Verschilzakking", wet, a.dewatering_depth_risk_reliability, ("Wanneer het grondwaterpeil sterk fluctueert – bijvoorbeeld door natte winters en droge zomers – ontstaan grotere verschillen in de grondwaterstand gedurende het jaar. Door klimaatverandering worden deze extremen steeds sterker: de winters worden natter, de zomers droger. Dit vergroot de dynamiek van het grondwaterpeil.", "Deze schommelingen hebben invloed op samendrukbare grondlagen zoals klei en veen. Tijdens droge perioden drogen deze lagen uit, waardoor ze inklinken (consolideren) en het pand geleidelijk zakt. In de natte maanden stijgt het grondwater vervolgens sneller tot aan de fundering, met een verhoogd risico op optrekkend vocht tot gevolg. Door deze cyclische belasting kunnen onder het pand ongelijkmatige zettingen ontstaan, waarbij de draagkracht op verschillende plekken afneemt. Dit kan leiden tot scheefstand en vervorming van het gebouw.")))
  }
  if bio != none {
    blocks.push(risk-block("Bacteriële aantasting", bio, a.bio_infection_risk_reliability, ("Bij de fundering kunnen grenenhouten palen zijn toegepast. Dit hout is gevoelig voor bacteriële aantasting, waarbij het van buitenaf over de volledige lengte wordt aangetast (ook wel palenpest genoemd). Hierdoor neemt het draagvermogen van de palen geleidelijk af, met verzakking van het pand als gevolg. In een vergevorderd stadium uit zich dit in scheurvorming in de gevel, klemmende ramen en deuren, en zichtbare verzakkingen in het gevelaanzicht.",)))
  }
  // The drawings, two to a row (grid-cols-2 gap-4), for the risks shown.
  let drawings = ()
  if dry != none { drawings.push(drawing("/assets/img/schimmelaantasting_droogstand.jpg", "Droogstand")) }
  if bio != none { drawings.push(drawing("/assets/img/bacteriele_aantasting.jpg", "Bacteriële aantasting")) }
  if wet != none {
    drawings.push(drawing("/assets/img/optrekkend_vocht.jpg", "Optrekkend vocht"))
    drawings.push(drawing("/assets/img/verschilzakking.jpg", "Verschilzakking"))
  }
  if drawings.len() > 0 { blocks.push(grid(columns: (1fr, 1fr), column-gutter: 16 * px, row-gutter: 16 * px, ..drawings)) }

  chapter("Funderingsrisico", icon: "alert", gap: 20 * px, {
    for (i, b) in blocks.enumerate() {
      if i > 0 { v(28 * px) }
      b
    }
  })
}
