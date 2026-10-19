// The report's shared building blocks: palette, labels and the pieces every chapter uses.
// Measured on the Gotenberg PDF of 2026-10-14 (Greycliff CF 8.06 pt, body ink #3e4550, margins 21.6 mm).
// ---- the report's palette (src/style.css @theme) and type (measured on a Gotenberg PDF of 2026-10-14)
#let blue-900 = rgb("#191e3c")
#let blue-500 = rgb("#17a4ea")
#let grey-100 = rgb("#f6f7f8")
#let grey-700 = rgb("#7f8fa4")
#let grey-800 = rgb("#3d5372")
#let grey-200 = rgb("#e8eaf1")
// Measured on the printed Gotenberg PDF: body text and values print in this dark grey, names in black.
#let ink = rgb("#3e4550")

// ---- the old page in CSS px: 1 CSS px of the Vue page = 0.677845 pt in the print.
#let px = 0.677845pt
// Chromium draws every glyph 0.21 pt right of its layout box (title 78.93 next to a box at 78.72, body 61.31 in
// the 61.10 column, Omgeving 83.00 at 82.79, legend 77.58 at 77.37): text blocks are shifted by this much.
#let text-dx = 0.21pt

// The report's page frame (report.typ: a4, margins 21.6 mm × 17 mm, set for the risk chapter) vs the Chromium
// frame of the old print: content box x 50.25 – 546.43, chapter column x 61.10 – 535.59, top 49.50.
// `px-page` puts its body on the chapter column with the old page top; the cover band reaches 10.85 pt further out.
// Chromium's A4 (8.27 × 11.69 in) and the old print's frame: text column x 61.31 – 535.59, y 49.50 – 792.42
#let page-width = 595.92pt
#let page-height = 841.92pt
#let page-margin-left = 61.31pt
#let page-margin-right = 60.33pt
#let page-margin-top = 49.5pt
#let page-margin-bottom = 49.5pt
#let column-x0 = 61.10pt
#let column-x1 = 535.59pt
#let page-top = 49.50pt

// The CSS text model: 12 px Greycliff, 18 px lines (leading-normal) with the baseline 13 px below the line top,
// a line with ExtraBold in it 19 px (6 px below), an ExtraBold-only line 18 px with the baseline at 12 px
// (Chromium rounds ascent/descent to whole px). Paragraph and block spacing are 0: every gap is explicit.
#let px-type(body) = {
  set text(size: 12 * px, top-edge: 13 * px, bottom-edge: -5 * px)
  set par(leading: 0pt, spacing: 0pt, justify: false)
  set block(spacing: 0pt)
  show strong: set text(top-edge: 12 * px, bottom-edge: -6 * px)
  body
}
#let px-page(body) = pad(
  left: column-x0 - page-margin-left,
  right: (page-width - column-x1) - page-margin-right,
  top: page-top - page-margin-top,
  px-type(body),
)
// a text block at Chromium's glyph position (see text-dx); the line width stays the box width
#let txt(body) = pad(left: text-dx, right: -text-dx, body)


// ---- labels (EFoundationRisk.ts, EReliability.ts)
#let risk-label = (
  a: "A (Geen risico)", b: "B (Laag risico)", c: "C (Verhoogd risico)",
  d: "D (Hoog risico)", e: "E (Aanzienlijk hoog risico)",
)
#let reliability-label = (
  indicative: "Indicatief", established: "Vastgesteld", cluster: "Afgeleid", supercluster: "Afgeleid",
)
// EFoundationTypeLabels (all 18 labels of report.foundation_type)
#let foundation-type-label = (
  wood: "Houten paalfundering",
  wood_amsterdam: "Houten (Amsterdamse) paalfundering",
  wood_rotterdam: "Houten (Rotterdamse) paalfundering",
  concrete: "Betonpaalfundering",
  no_pile: "Ondiepe fundering",
  no_pile_masonry: "Ondiepe fundering, gemetseld",
  no_pile_strips: "Ondiepe fundering, stroken",
  no_pile_bearing_floor: "Ondiepe fundering, plaatfundering",
  no_pile_concrete_floor: "Ondiepe fundering, betonvloer",
  no_pile_slit: "Ondiepe fundering, slieten",
  wood_charger: "Houten paal met betonoplanger",
  weighted_pile: "Verzwaarde puntpaal",
  combined: "Gecombineerde fundering",
  steel_pile: "Stalen buispaal",
  other: "Overig",
  wood_rotterdam_amsterdam: "Houten (Rotterdamse/Amsterdamse) paalfundering",
  wood_rotterdam_arch: "Houten (Rotterdamse) paalfundering met spaarboog",
  wood_amsterdam_arch: "Houten (Amsterdamse) paalfundering met spaarboog",
)
// ESubstructureLabels
#let substructure-label = (cellar: "Kelder", basement: "Souterrain", crawlspace: "Kruipruimte", "none": "Geen")
// ESoilLabels; a code not in the map prints as is (soilLabel = ESoilLabels.get(soil) || soil)
#let soil-label = (
  az: "Afgesloten Zeearmen", du: "Duinen", hl: "Heuvelland", hz: "Zandgronden", lv: "Laagveengronden",
  ni: "Stedelijk gebied", zk: "Zeekleigebied", "ni-du": "Duinen", "ni-hl": "Heuvelland", "ni-lv": "Laagveengronden",
  "ni-hz": "Zandgronden", "ni-zk": "Zeekleigebied", ri: "Rivierengebied",
)
#let months-nl = ("januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september",
  "oktober", "november", "december")

// ---- values as the Vue code formats them
#let no-data = "Geen data"
#let has(v) = v != none and v != ""
// Integer with nl-NL grouping: 1200 -> "1.200"
#let group-nl(n) = {
  let s = str(calc.abs(n))
  let out = ""
  for (i, c) in s.clusters().enumerate() {
    if i > 0 and calc.rem(s.len() - i, 3) == 0 { out += "." }
    out += c
  }
  (if n < 0 { "-" } else { "" }) + out
}
// toDecimals: toLocaleString("nl-NL", 2 decimals): rounding half away from zero on the shortest decimal form
// (1.005 -> 1,01), "." thousands, and "-0,00" for a value in (-0.005, 0) (kept on purpose, as today).
#let to-decimals(v) = {
  let s = str(v)
  let d = if s.contains("e") { decimal(str(calc.round(v, digits: 6))) } else { decimal(s) }
  let cents = int(calc.round(calc.abs(d) * 100))
  (if d < 0 { "-" } else { "" }) + group-nl(int(cents / 100)) + "," + str(calc.rem(cents, 100) + 100).slice(1)
}
// retrieveAndFormatFieldData: null / '' -> "Geen data", else the formatter
#let field(v, fmt: x => str(x)) = if has(v) { fmt(v) } else { no-data }
#let to-nap(v) = to-decimals(v) + " m t.o.v. NAP"
#let to-maaiveld(v) = to-decimals(v) + " m beneden maaiveldniveau"
#let to-square-m(v) = to-decimals(v) + " m²"
#let to-meters(v) = to-decimals(v) + " m"
// fullAddress (adaptGeoLocationData)
#let full-address(bi) = {
  let pc = bi.at("postal_code", default: none)
  if has(pc) and pc.match(regex("^\d{4}\s?[A-Za-z]{2}$")) != none { pc = pc.slice(0, 4) + " " + pc.slice(-2) }
  let parts = (
    (bi.at("street", default: none), bi.at("building_number", default: none)).filter(has).join(" "),
    (pc, bi.at("city", default: none)).filter(has).join(" "),
  ).filter(has)
  if parts.len() == 0 { "" } else { parts.join(", ") }
}
// "14 oktober 2026" from "2026-10-14" (toLocaleDateString nl-NL, day without a leading zero)
#let date-nl(iso) = {
  let (y, m, d) = iso.split("-").map(int)
  str(d) + " " + months-nl.at(m - 1) + " " + str(y)
}

// ---- building blocks
// Chapter.vue header: the icon (16 px square, print colours: black + #17a4ea), 10 px gap, h2 16 px ExtraBold with
// -0.02 em tracking and its baseline 14 px below the header top. `gap` is the space to the section: 20 px in the
// CSS text model (px-type: the first baseline sits 13 px into its line); the default (16.89 pt: the old 4 mm header + 16.4 pt) keeps the risk chapter, whose
// text model starts a paragraph at its cap height, where it was calibrated. icon: none -> title at the column start.
#let front-icons = ("home-info", "info", "building", "pin")
#let icon-path(name) = if name in front-icons { "/assets/front/icons-print/" + name + ".svg" } else {
  "/assets/icons/print/" + name + ".svg"
}
#let chapter(title, icon: "alert", gap: 4mm + 16.4pt - 16 * px, body) = {
  block(below: gap, breakable: false, sticky: true, width: 100%, height: 16 * px, {
    if icon != none { place(top + left, image(icon-path(icon), width: 16 * px, height: 16 * px)) }
    place(top + left, dx: (if icon != none { 26 * px } else { 0pt }) + text-dx, text(
      size: 16 * px, weight: 800, tracking: -0.02em, fill: black, top-edge: 14 * px, bottom-edge: -4 * px, title))
  })
  body
}

// One risk: shield + name + class | reliability, as the two halves of the Vue row.
#let risk-row(name, level, reliability) = block(breakable: false, below: 11.2pt, grid(
  columns: (1fr, 1fr), align: horizon,
  grid(columns: (auto, auto, auto), column-gutter: 2.2mm, align: horizon,
    image("/assets/icons/risk-" + level + ".svg", height: 4mm),
    name,
    text(fill: ink, risk-label.at(level)),
  ),
  grid(columns: (auto, auto), column-gutter: 2.6mm,
    "Betrouwbaarheid",
    text(fill: ink, reliability-label.at(reliability, default: "-")),
  ),
))

#let explain(body) = text(fill: ink, body)

// RiskNextSteps.vue: the advice scales with the class.
#let next-steps(level) = {
  let tone = if level in ("a", "b") { "low" } else if level == "c" { "medium" } else { "high" }
  block(breakable: false, above: 19.7pt, below: 24.7pt, width: 100%, stroke: (top: 0.5pt + grey-200), inset: (top: 3mm), {
    block(below: 12.35pt, text(size: 8.7pt, weight: 800, fill: grey-800, "Volgende stappen"))
    explain(if tone == "low" [
      #(if level == "a" { "Er is geen verhoogd risico." } else { "Het risico is laag." }) Een aanvullend
      onderzoek is op dit moment meestal niet nodig. Houd het pand wel in de gaten op zichtbare
      signalen – scheurvorming, klemmende ramen of deuren, zichtbare verzakkingen – en raadpleeg
      dit rapport opnieuw als die zich voordoen of bij een ingrijpende verbouwing.
    ] else if tone == "medium" [
      Het risico is verhoogd. Acute maatregelen zijn nu meestal nog niet nodig, maar het is
      verstandig om alert te blijven op zichtbare signalen (scheurvorming, vocht, scheefstand). Bij
      twijfel – of bij verkoop of verbouwing van het pand – is een KCAF QuickScan een goede
      vervolgstap (zie hoofdstuk ‘Aanvullend onderzoek’).
    ] else [
      Het risico is hoog. Wij adviseren een #text(fill: ink, strong[KCAF QuickScan]) als vervolgstap – een
      relatief snelle en betaalbare beoordeling die uitwijst of aanvullend funderingsonderzoek op
      locatie nodig is (zie hoofdstuk ‘Aanvullend onderzoek’). Bij zichtbare schade aan de gevel of
      constructie is een specialistisch funderingsonderzoek aangewezen.
    ])
  })
}

#let drawing(file, caption) = block(breakable: false, {
  block(below: 3.1pt, stroke: 0.5pt + grey-200, radius: 1.5mm, clip: true, image(file, width: 100%))
  align(center, text(weight: 800, fill: ink, caption))
})

// A map from map.ts: the SVG shapes, then the street names (halo first, letters on top: Typst draws a text stroke
// over its fill), then the pand as the navy dot of pandMarker.ts (circle-radius 9 px #191e3c, a 3 px white
// stroke outside it). `m` is <prefix>.labels.json, `svg` the path. The image fills the box like object-fit: cover
// (the 717 × 319 snapshot in the 495 : 220 box of the print: 0.3 pt of it is cut off, half at the top and bottom).
#let map-box(m, svg, width: 100%, height: auto, radius: 0pt) = layout(size => {
  let w = if type(width) == ratio { size.width * width } else { width }
  let s = w / m.width // one map pixel, as a length
  let h = if height == auto { m.height * s } else { height }
  let dy = (h - m.height * s) / 2
  block(width: w, height: h, clip: true, radius: radius, place(dy: dy, {
    place(image(svg, width: w))
    for l in m.labels {
      for layer in ((fill: rgb("#fbf8f1"), stroke: 2.6 * s + rgb("#fbf8f1")), (fill: rgb("#8c6e3a"), stroke: none)) {
        place(dx: l.x * s, dy: l.y * s, place(center + horizon, rotate(l.angle * 1deg, reflow: false,
          text(size: m.size * s * 1.1, weight: 400, top-edge: "cap-height", bottom-edge: "baseline", ..layer, l.text))))
      }
    }
    place(dx: w / 2, dy: m.height * s / 2, place(center + horizon,
      circle(radius: 10.5 * s, fill: blue-900, stroke: 3 * s + white)))
  }))
})

// dl.list--definition: one row per item, dt left (black), dd right-aligned (#3e4550), 24 px lines (leading-loose)
// with the baseline 16 px down; 12 px between dt and dd.
#let definition-list(rows) = txt({
  set text(top-edge: 16 * px, bottom-edge: -8 * px)
  for (dt, dd) in rows {
    grid(columns: (auto, 1fr), column-gutter: 12 * px, dt, align(right, text(fill: ink, dd)))
  }
})

// The grey .highlight box: #f6f7f8 (highlight-bg.png), radius 4 px, padding 32 px.
#let highlight(body) = block(width: 100%, fill: grey-100, radius: 4 * px, inset: 32 * px, clip: true, body)
