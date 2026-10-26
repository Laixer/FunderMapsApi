// Shared blocks of the back half (Fundering … Disclaimer).
// Everything is laid out in CSS px of the Vue page and converted with the PDF's own factor (1 px = 0.677845 pt),
// so the old print's vertical rhythm comes out exactly: 18-px body lines with the baseline 13 px from the top,
// 24-px definition rows, 16-px chapter headers, and the space-y-* gaps between blocks.
#import "@preview/cetz:0.4.2"
#import "lib.typ": blue-500, blue-900, grey-200, grey-800, ink

#let px(n) = n * 0.677845pt
#let grey-100 = rgb("#f6f7f8")
#let grey-400 = rgb("#ced0da")
#let link-green = rgb("#177851") // green-500 as Chromium prints a link
#let chart-grey = rgb("#666666") // Chart.js default text colour
#let grid-grey = rgb("#e5e5e5") // rgba(0,0,0,.1) on white
#let axis-grey = rgb("#cecece") // two rgba(0,0,0,.1) strokes on white

// ---- type: the whole back half runs inside back-type, independent of the caller's text settings.
// Body 12 px Greycliff; one line = 18 px with the baseline 13 px below its top (Chromium rounds the font's
// ascent/descent to 11 + 3 px and puts the 2 px half-leading above and below). Leading and block spacing are 0:
// every gap is an explicit v() of the old CSS margin.
#let back-type(body) = {
  set text(font: "Greycliff CF", size: px(12), weight: 400, style: "normal", tracking: 0pt, fill: black,
    lang: "nl", region: "nl", hyphenate: false, top-edge: px(13), bottom-edge: -px(5))
  set par(leading: 0pt, spacing: 0pt, justify: false, first-line-indent: 0pt, hanging-indent: 0pt,
    linebreaks: "simple")
  set block(spacing: 0pt)
  set smartquote(enabled: false) // the old texts use ASCII ' and typed ‘ ’
  body
}
#let gap(n) = v(px(n))
#let wgap(n) = v(px(n), weak: true) // a top-level margin, dropped at a page break
// <strong> inside a line: the line keeps the Regular strut (13 px above) and gets ExtraBold's 6 px below (19 px).
#let b(body) = text(weight: 800, top-edge: px(13), bottom-edge: -px(6), body)
// display:block <strong>: ExtraBold strut only, 12 px above and 6 px below (18 px).
#let block-b(body, fill: black) = block(text(weight: 800, fill: fill, top-edge: px(12), bottom-edge: -px(6), body))

// ---- Chromium's line breaks. Chromium on Linux (DPR 1, no subpixel positioning) advances every glyph by a whole
// px, so its words are up to ±2.5 % wider or narrower than Typst's exact advances and its lines break elsewhere.
// cr-width gives a string's width as Chromium measures it (each glyph's advance rounded to a px); para breaks a
// paragraph greedily with those widths (at spaces and after a hyphen between letters, trailing space hanging) and
// sets every line as its own unbreakable line (squeezed by a hair of tracking in the rare case that the exact
// Typst line is wider than the column). Reproduced the old table columns to 0.07 pt and every paragraph break of
// the reference pages. Set chromium-breaks to false to let Typst break the paragraphs itself.
#let chromium-breaks = true
#let glyph-px(c, weight) = calc.round(measure(text(weight: weight, c)).width / px(1))
#let space-px(weight) = calc.round((measure(text(weight: weight, "x x")).width
  - measure(text(weight: weight, "xx")).width) / px(1))
#let kern-px(a, b, weight) = calc.round((measure(text(weight: weight, a + b)).width
  - measure(text(weight: weight, a)).width - measure(text(weight: weight, b)).width) / px(1))
// each glyph: its advance rounded to a px, plus its kerning with the next glyph rounded on its own (checked on
// every word start of a full reference line: exact to the px)
#let cr-width(s, weight: 400) = {
  let cs = s.clusters()
  cs.enumerate().map(((i, c)) => glyph-px(c, weight)
    + if i + 1 < cs.len() { kern-px(c, cs.at(i + 1), weight) } else { 0 }).sum(default: 0) * px(1)
}

// runs: a string ("\n" = forced line break), a dictionary (t: string, url:, fill:), or an array of these.
#let cpara-lines(runs, avail-px, weight: 400) = {
  let atoms = () // (kind, t, run)
  for (ri, r) in runs.enumerate() {
    for m in r.t.matches(regex("\n| |[^ \n]+")) {
      let t = m.text
      if t == "\n" { atoms.push((kind: "br", t: t, run: ri)) } else if t == " " {
        atoms.push((kind: "sp", t: t, run: ri))
      } else {
        // a break opportunity after a hyphen between letters ("InSAR-analyse", "quickscan-risicobeoordeling")
        let cs = t.clusters()
        let letter(c) = c.match(regex("^\p{L}$")) != none
        let p = ""
        for (i, c) in cs.enumerate() {
          p += c
          if c == "-" and i > 0 and i + 1 < cs.len() and letter(cs.at(i - 1)) and letter(cs.at(i + 1)) {
            atoms.push((kind: "w", t: p, run: ri))
            p = ""
          }
        }
        if p != "" { atoms.push((kind: "w", t: p, run: ri)) }
      }
    }
  }
  let sp = space-px(weight)
  let lines = ()
  let cur = ()
  let w = 0
  let pending = none
  for a in atoms {
    if a.kind == "br" { lines.push(cur); cur = (); w = 0; pending = none; continue }
    if a.kind == "sp" { if cur.len() > 0 { pending = a }; continue }
    let aw = cr-width(a.t, weight: weight) / px(1)
    let sw = if pending != none { sp } else { 0 }
    if cur.len() > 0 and w + sw + aw > avail-px + 0.01 {
      lines.push(cur)
      cur = (a,)
      w = aw
    } else {
      if pending != none { cur.push(pending) }
      cur.push(a)
      w += sw + aw
    }
    pending = none
  }
  lines.push(cur)
  lines
}
#let run-text(r, t) = {
  let body = if r.at("fill", default: none) != none { text(fill: r.fill, t) } else { text(t) }
  if r.at("url", default: none) != none { link(r.url, body) } else { body }
}
// align: where each line sits, from its Chromium width (text-end values, centred captions); weight: the face.
#let para(body, fill: ink, align: left, weight: 400) = {
  if type(body) == str or type(body) == dictionary { body = (body,) }
  if type(body) != array or not chromium-breaks {
    return block(width: 100%, std.align(align, text(fill: fill, weight: weight, if type(body) == array {
      body.map(r => if type(r) == str { r } else { run-text(r, r.t) }).join()
    } else { body })))
  }
  let runs = body.map(r => if type(r) == str { (t: r) } else { r })
  layout(size => context {
    let lines = cpara-lines(runs, size.width / px(1), weight: weight)
    block(width: 100%, text(fill: fill, weight: weight, {
      for line in lines {
        // merge neighbouring atoms of one run, so kerning and links stay whole
        let segs = ()
        for a in line {
          if segs.len() > 0 and segs.last().run == a.run { segs.last().t += a.t } else { segs.push((run: a.run, t: a.t)) }
        }
        // (an empty line, from a leading "\n", keeps its 18 px through a zero-width space)
        let content = if segs.len() == 0 { [#sym.zws] } else { segs.map(s => run-text(runs.at(s.run), s.t)).join() }
        let n = line.map(a => a.t.clusters().len()).sum(default: 0)
        let over = measure(content).width - size.width
        if over > 0pt and n > 1 { content = text(tracking: -(over + 0.1pt) / (n - 1), content) }
        let cw = line.map(a => if a.kind == "sp" { space-px(weight) * px(1) } else { cr-width(a.t, weight: weight) })
          .sum(default: 0pt)
        let dx = if align == right { size.width - cw } else if align == center { (size.width - cw) / 2 } else { 0pt }
        block(width: 100%, if dx > 0pt and over <= 0pt { move(dx: dx, box(content)) } else { content })
      }
    }))
  })
}
// h3 (11 px ExtraBold, -0.02 em, 12.375-px line, baseline 10 px below its top)
#let h3(body) = block(text(size: px(11), weight: 800, tracking: -0.02em, top-edge: px(10), bottom-edge: -px(2.375),
  body))

// Chapter.vue header: 16-px icon, 10 px, h2 16 px ExtraBold -0.02 em (baseline 14 px below the 16-px box top),
// then 20 px to the section. Without an icon the title starts at the column edge (the closing articles).
#let back-header(title, icon: none) = block(width: 100%, height: px(16), sticky: true, below: px(20), {
  if icon != none {
    place(top + left, image("/assets/icons/print/" + icon + ".svg", width: px(16), height: px(16)))
  }
  place(top + left, dx: if icon == none { 0pt } else { px(26) },
    text(size: px(16), weight: 800, tracking: -0.02em, top-edge: px(14), bottom-edge: -px(4), title))
})

// Tailwind's grid-cols-12 gap-4 on a column of width w: the width of an n-column span.
#let span(w, n, cols: 12, gutter: px(16)) = (w - gutter * (cols - 1)) / cols * n + gutter * (n - 1)

// dl.list--definition: label left (black), value right-aligned (grey), 24-px rows (leading-loose, baseline 16 px).
#let def-rows(rows) = {
  set text(top-edge: px(16), bottom-edge: -px(8))
  for (label, value) in rows {
    block(width: 100%, grid(columns: (auto, 1fr), column-gutter: px(12), label, para(value, align: right)))
  }
}

// ItemGrid.vue row: two equal columns 16 px apart, 3 px padding, 18-px lines; a label with "(" puts the
// bracketed part in RegularOblique and keeps it on one line (whitespace-nowrap).
#let item-label(label) = {
  let i = label.position("(")
  if i == none { label } else {
    label.slice(0, i)
    box(text(style: "italic", label.slice(i)))
  }
}
#let item-grid(label, value) = block(width: 100%, inset: (y: px(3)), grid(columns: (1fr, 1fr),
  column-gutter: px(16), item-label(label), if type(value) == str { para(value) } else { text(fill: ink, value) }))

// .highlight: #f6f7f8 (the printed highlight-bg.png), radius 4 px, padding 32 px.
#let highlight(body, width: 100%) = block(width: width, fill: grey-100, radius: px(4), inset: px(32), body)

// ---- formatting (back-common.md §3): nl-NL, ASCII minus, "." thousands, "," decimals, half away from zero.
#let group3(digits) = {
  let cs = digits.clusters()
  let out = ""
  for (i, c) in cs.enumerate() {
    if i > 0 and calc.rem(cs.len() - i, 3) == 0 { out += "." }
    out += c
  }
  out
}
#let nl-number(v, decimals: 2) = {
  let x = float(v)
  let f = calc.pow(10, decimals)
  let n = int(calc.floor(calc.abs(x) * f + 0.5))
  let ip = calc.div-euclid(n, f)
  let fp = str(calc.rem(n, f))
  let sign = if x < 0 and n > 0 { "-" } else { "" }
  sign + group3(str(ip)) + if decimals > 0 { "," + "0" * (decimals - fp.len()) + fp } else { "" }
}
#let nl-int(v) = nl-number(v, decimals: 0)
#let fmt-mm-year(v) = nl-number(v) + " mm/jaar"
#let fmt-mm(v) = nl-number(v) + " mm"
#let fmt-m(v) = nl-number(v) + " m"
#let fmt-nap(v) = nl-number(v) + " m t.o.v. NAP"
#let fmt-scale(v) = "1:" + str(int(calc.round(float(v))))
#let is-date(s) = type(s) == str and s.match(regex("^\d{4}-\d{2}-\d{2}")) != none
#let date-dmy(s) = s.slice(0, 10).split("-").rev().join("-")
#let months-long = ("januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september",
  "oktober", "november", "december")
#let months-short = ("jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec")
#let date-long(s) = {
  let p = s.slice(0, 10).split("-")
  str(int(p.at(2))) + " " + months-long.at(int(p.at(1)) - 1) + " " + p.at(0)
}

// ---- the field engine (fieldData.ts): "Geen data" for null/''/missing, enum -> label ('' when unknown),
// booleans -> ja/nee, else a formatter or the value itself.
#let no-data = "Geen data"
#let present(v) = v != none and v != ""
#let field(obj, key, labels: none, fmt: none) = {
  if obj == none { return no-data }
  let v = obj.at(key, default: none)
  if not present(v) { return no-data }
  if labels != none { return labels.at(str(v), default: "") }
  if type(v) == bool { return if v { "ja" } else { "nee" } }
  if fmt != none { return fmt(v) }
  str(v)
}
#let has-value(s) = s != "" and s != no-data

// ---- enum maps (back-common.md §4), PG label -> printed label
#let inquiry-type-label = (
  additional_research: "Aanvullend onderzoek", monitoring: "Monitoring", note: "Notitie", quickscan: "QuickScan",
  unknown: "Onbekend", demolition_research: "Sloopgrensonderzoek", second_opinion: "Second opinion",
  archive_research: "Archiefonderzoek", architectural_research: "Bouwkundig onderzoek",
  foundation_advice: "Funderingsadvies", inspectionpit: "Onderzoeksput", foundation_research: "Funderingsonderzoek",
  ground_water_level_research: "Grondwateronderzoek", soil_investigation: "Grondonderzoek",
  facade_scan: "Gevelscan",
)
#let foundation-type-label = (
  wood: "Houten paalfundering", wood_amsterdam: "Houten (Amsterdamse) paalfundering",
  wood_rotterdam: "Houten (Rotterdamse) paalfundering", concrete: "Betonpaalfundering", no_pile: "Ondiepe fundering",
  no_pile_masonry: "Ondiepe fundering, gemetseld", no_pile_strips: "Ondiepe fundering, stroken",
  no_pile_bearing_floor: "Ondiepe fundering, plaatfundering", no_pile_concrete_floor: "Ondiepe fundering, betonvloer",
  no_pile_slit: "Ondiepe fundering, slieten", wood_charger: "Houten paal met betonoplanger",
  weighted_pile: "Verzwaarde puntpaal", combined: "Gecombineerde fundering", steel_pile: "Stalen buispaal",
  other: "Overig", wood_rotterdam_amsterdam: "Houten (Rotterdamse/Amsterdamse) paalfundering",
  wood_rotterdam_arch: "Houten (Rotterdamse) paalfundering met spaarboog",
  wood_amsterdam_arch: "Houten (Amsterdamse) paalfundering met spaarboog",
)
#let reliability-label-back = (
  indicative: "Indicatief", established: "Vastgesteld", cluster: "Afgeleid", supercluster: "Afgeleid",
)
#let enforcement-term-label = (
  term05: "0 tot 5 jaar", term510: "5 tot 10 jaar", term1020: "10 tot 20 jaar", term5: "tot 5 jaar (F3O)",
  term10: "tot 10 jaar (F3O)", term15: "tot 15 jaar (F3O)", term20: "tot 20 jaar (F3O)", term25: "tot 25 jaar (F3O)",
  term30: "tot 30 jaar (F3O)", term40: "tot 40 jaar (F3O)",
)
#let damage-cause-label = (
  drainage: "Te lage grondwaterstand", construction_flaw: "Constructiefouten", drystand: "Droogstand houten paalkop",
  overcharge: "Overbelasting", overcharge_negative_cling: "Overbelasting en/of negatieve kleef",
  negative_cling: "Negatieve kleef", bio_infection: "Bacteriële aantasting (palenpest)",
  fungus_infection: "Schimmelaantasting (paalrot)", bio_fungus_infection: "Bacteriële en/of schimmelaantasting",
  foundation_flaw: "Funderingsfouten", construction_heave: "Opdrukking pand", subsidence: "Verzakking",
  vegetation: "Beschadiging fundering door planten en wortels", gas: "Gaswinning", vibrations: "Trillingen",
  partial_foundation_recovery: "Partieel funderingsherstel",
  japanese_knotweed: "Beschadiging fundering door Japanse duizendknoop",
  groundwater_level_reduction: "Verlaging van grondwaterniveau",
)
#let damage-characteristics-label = (
  jamming_door_window: "Klemmende deuren en ramen", crack: "Scheuren", skewed: "Scheefstand",
  crawlspace_flooding: "Water in kruipruimte", threshold_above_subsurface: "Drempel boven maaiveld",
  threshold_below_subsurface: "Drempel onder maaiveld", crooked_floor_wall: "Scheve vloer of wand",
)
#let foundation-quality-label = (
  bad: "Slecht", mediocre: "Matig", tolerable: "Redelijk", good: "Goed", mediocre_good: "Matig tot goed",
  mediocre_bad: "Matig tot slecht",
)
#let substructure-label = (cellar: "Kelder", basement: "Souterrain", crawlspace: "Kruipruimte", "none": "Geen")
#let crack-type-label = (
  "none": "Geen", nil: "Zeer klein (haarscheuren)", small: "Klein (0,5 - 1 mm)", mediocre: "Matig (1 - 3 mm)",
  big: "Groot (> 3 mm)",
)
#let rotation-type-label = (nil: "Nihil", small: "Klein", mediocre: "Middelmatig", big: "Groot", very_big: "Zeer groot")
#let recovery-type-label = (
  table: "Tafelfundering", beam_on_pile: "Opzetters", pile_lowering: "Paalkopverlaging",
  pile_in_wall: "Paalinkassing in (muur)", injection: "Grondinjectie/verbetering", unknown: "Onbekend",
)
#let facade-label = (front: "Voorgevel", sidewall_left: "Linkergevel", sidewall_right: "Rechtergevel",
  rear: "Achtergevel")

// ---- report data as the store combines it (back-common.md §5)
#let arr(v) = if v == none { () } else { v }

// ---- fixes for defects of the old report, each switched on by name in the `fixes` input (comma-separated;
// render.ts passes env PDF_FIXES). None named = the report as the Vue version printed it.
//   gevelscan         the Gevelscan chapter, which never printed
//   palen             Fundering's "Palen & Hout" and "Niveau & Kwaliteit" blocks, which never printed
//   risk-highest      the neighbourhood pie by each pand's highest risk class, as its text says (was the lowest)
//   reports-distinct  "Aantal rapportages in de wijk per jaar" counts reports, not their sample rows
//   herstel-latest    Funderingsherstel shows the latest herstel, not the record edited last
//   meldingen         Incidenten names the topics of the pand's own meldingen (Don's rule: pand and topic only)
#let fixes = sys.inputs.at("fixes", default: "").split(",").map(s => s.trim()).filter(s => s != "")
#let fixed(name) = name in fixes

// enum maps for the fixes (FunderMapsReport src/datastructures/enums, FunderMapsWebFront EIncidentQuestionType)
#let quality-label = (nil: "Slecht", small: "Redelijk", mediocre: "Goed", large: "Zeer goed")
#let wood-type-label = (pine: "Grenen", spruce: "Vuren")
#let wood-quality-label = (area1: "Gebied I", area2: "Gebied II", area3: "Gebied III", area4: "Gebied IV")
#let wood-encroachment-label = (fungus_infection: "Schimmelaantasting",
  bio_fungus_infection: "Bacteriële en schimmelaantasting", bio_infection: "Bacteriële aantasting")
#let question-type-label = (buy_sell: "Kopen/verkopen", registration: "Registratie", legal: "Juridische vraag",
  financial: "Financiële vraag", guidance: "Begeleiding", recovery: "Herstelvraag", research: "Onderzoeksvraag",
  other: "Overig")
// Reports newest document_date first (string compare, null last), ties by the higher id.
#let sorted-inquiries(report) = arr(report.at("inquiries", default: none)).sorted(key: i => {
  let dd = i.at("document_date", default: none)
  (if dd == none { "" } else { dd }) + "|" + "0" * (12 - str(i.id).len()) + str(i.id)
}).rev()
#let inquiry-entries(report) = {
  let samples = arr(report.at("inquiry_samples", default: none))
  let out = ()
  for r in sorted-inquiries(report) {
    let own = samples.filter(s => s.inquiry_id == r.id)
    if own.len() == 0 { out.push((report: r, sample: none)) } else {
      for s in own { out.push((report: r, sample: s)) }
    }
  }
  out
}
#let recovery-entries(report) = {
  let samples = arr(report.at("recovery_samples", default: none))
  let out = ()
  for r in arr(report.at("recoveries", default: none)) {
    let own = samples.filter(s => s.recovery_id == r.id)
    if own.len() == 0 { out.push((recovery: r, sample: none)) } else {
      for s in own { out.push((recovery: r, sample: s)) }
    }
  }
  out
}

// ---- legend list (.list--legenda): h3, 12 px, items 8 px apart; a 10-px dot whose bottom sits on the baseline,
// the label 20 px from the column start.
#let legend-list(title, items) = block({
  h3(title)
  gap(12)
  for (i, it) in items.enumerate() {
    if i > 0 { gap(8) }
    block(width: 100%, height: px(18), {
      place(top + left, dx: 0.28pt, dy: px(3), circle(radius: px(5), fill: it.at(0), stroke: none))
      place(top + left, dx: px(20), text(fill: black, it.at(1)))
    })
  }
})

// ---- Chart.js pieces --------------------------------------------------------------------------------------
// Pie (PieChart.vue): slices from 12 o'clock clockwise, disc radius (n - 4) / 2 canvas px, a 2-px white outline
// on every slice when more than one slice is > 0, except slices whose rim is under 7 px.
#let pie(values, colors, n, side) = {
  let total = values.sum(default: 0)
  let unit = side / n
  cetz.canvas(length: unit, {
    import cetz.draw: *
    rect((0, 0), (n, n), stroke: none, fill: none)
    if total > 0 {
      let r = (n - 4) / 2
      let c = (n / 2, n / 2)
      let shown = values.filter(v => v > 0).len()
      let cum = 0
      for (i, v) in values.enumerate() {
        if v <= 0 { continue }
        let share = v / total
        let outline = shown > 1 and share * calc.pi * n >= 7
        let st = if outline { (paint: white, thickness: 2 * unit, join: "round") } else { none }
        let col = colors.at(calc.rem(i, colors.len()))
        if share >= 0.99999 {
          circle(c, radius: r, fill: col, stroke: st)
        } else {
          let a0 = 90deg - cum * 360deg
          let a1 = 90deg - (cum + share) * 360deg
          arc(c, start: a1, stop: a0, radius: r, mode: "PIE", anchor: "origin", fill: col, stroke: st)
        }
        cum += share
      }
    }
  })
}

// Chart.js LinearScale tick generation (generateTicks + niceNum), bounds 'ticks'.
#let nice-num(range) = {
  let rr = calc.round(range)
  let r = if calc.abs(range - rr) < range / 1000 { rr } else { range }
  let e = calc.floor(calc.log(r, base: 10) + 1e-9)
  let nr = calc.pow(10.0, e)
  let f = r / nr
  (if f <= 1 { 1 } else if f <= 2 { 2 } else if f <= 5 { 5 } else { 10 }) * nr
}
#let gen-ticks(rmin, rmax, max-ticks, precision: none) = {
  let max-spaces = max-ticks - 1
  let spacing = nice-num((rmax - rmin) / max-spaces)
  let num-spaces = calc.ceil(rmax / spacing) - calc.floor(rmin / spacing)
  if num-spaces > max-spaces { spacing = nice-num(num-spaces * spacing / max-spaces) }
  if precision != none {
    let f = calc.pow(10, precision)
    spacing = calc.ceil(spacing * f) / f
  }
  let nmin = calc.floor(rmin / spacing) * spacing
  let nmax = calc.ceil(rmax / spacing) * spacing
  let ns = (nmax - nmin) / spacing
  ns = if calc.abs(ns - calc.round(ns)) < spacing / 1000 { int(calc.round(ns)) } else { int(calc.ceil(ns)) }
  range(ns + 1).map(j => nmin + j * spacing)
}
// Chart.js handleTickRangeOptions for a value axis with beginAtZero.
#let value-range(vals, zero: true) = {
  let lo = calc.min(..vals)
  let hi = calc.max(..vals)
  if zero { lo = calc.min(lo, 0); hi = calc.max(hi, 0) }
  if lo == hi {
    let off = if hi == 0 { 1 } else { calc.abs(hi * 0.05) }
    hi += off
    if not zero { lo -= off }
  }
  (lo, hi)
}
// Canvas text: 12 px Greycliff, measured in canvas px (one canvas px = `unit`).
#let canvas-text(body, unit, weight: 400, fill: chart-grey) = text(size: 12 * unit, weight: weight, fill: fill,
  top-edge: "cap-height", bottom-edge: "baseline", tracking: 0pt, body)
// Chromium canvas baselines for a 12-px Greycliff line: 'middle' -> baseline 4.21 px lower, 'top' -> 11.26 px.
#let mid-to-base = 0.3505 * 12
#let top-to-base = 0.938 * 12

// Bar chart (BarChart.vue, gradient on): 716 x 358 canvas px shown at the column width. rapportage.md §6.
#let bar-chart(labels, values, title, width) = context {
  let W = 716
  let H = 358
  let unit = width / W
  let (lo, hi) = value-range(values)
  let top = 34
  let bottom = 329
  let ticks = gen-ticks(lo, hi, calc.min(11, calc.ceil((bottom - top) / 14.4)), precision: 0)
  let tick-labels = ticks.map(t => nl-int(t))
  let label-w = calc.max(..tick-labels.map(l => measure(canvas-text(l, unit)).width / unit))
  let left = label-w + 3 + 8
  let (amin, amax) = (ticks.first(), ticks.last())
  let y-of(v) = bottom - (v - amin) / (amax - amin) * (bottom - top)
  let n = labels.len()
  let cw = (W - left) / n
  let bw = calc.min(60, 0.72 * cw)
  // x labels: skip when they collide (show every k-th, Chart.js autoSkip style)
  let xl-w = calc.max(..labels.map(l => measure(canvas-text(l, unit)).width / unit))
  let k = calc.max(1, calc.ceil((xl-w + 6) / cw))
  // gradient over the plot height: stops 0, s, 2s, 3s, 4s
  let s = calc.max(10, calc.min(150, calc.round(calc.max(..values) / 4)))
  let stop-cols = (rgb("#b0d2e8"), rgb("#73b3d8"), rgb("#3e8ec4"), rgb("#1563aa"), rgb("#08306b"))
  let stops = range(5).map(i => (calc.clamp((i * s - amin) / (amax - amin), 0, 1), stop-cols.at(i)))
  let grad-at(o) = {
    if o <= stops.first().at(0) { return stops.first().at(1) }
    for i in range(1, stops.len()) {
      let (o1, c1) = stops.at(i)
      let (o0, c0) = stops.at(i - 1)
      if o <= o1 {
        let t = if o1 == o0 { 1 } else { (o - o0) / (o1 - o0) }
        return color.mix((c0, (1 - t) * 100%), (c1, t * 100%), space: rgb)
      }
    }
    stops.last().at(1)
  }
  let bar-fill(o0, o1) = {
    let pts = ((grad-at(o0), 0%),)
    for (o, c) in stops { if o > o0 and o < o1 { pts.push((c, (o - o0) / (o1 - o0) * 100%)) } }
    pts.push((grad-at(o1), 100%))
    gradient.linear(..pts, dir: btt)
  }
  cetz.canvas(length: unit, {
    import cetz.draw: *
    let P(x, y) = (x, -y)
    let line1 = (paint: grid-grey, thickness: unit)
    rect(P(0, 0), P(W, H), stroke: none, fill: none)
    content(P(W / 2, 10 + 7.2 + mid-to-base), anchor: "south", canvas-text(title, unit, weight: 800))
    for (i, t) in ticks.enumerate() {
      let y = y-of(t)
      if i > 0 { line(P(left - 8, y), P(W, y), stroke: line1) }
      content(P(left - 11, y), anchor: "east", canvas-text(tick-labels.at(i), unit))
    }
    for i in range(1, n) { line(P(left + i * cw, top), P(left + i * cw, bottom + 8), stroke: line1) }
    // axis borders: two overlapping strokes
    line(P(left - 8, bottom), P(W, bottom), stroke: (paint: axis-grey, thickness: unit))
    line(P(left, top), P(left, bottom + 8), stroke: (paint: axis-grey, thickness: unit))
    for (i, v) in values.enumerate() {
      let cx = left + (i + 0.5) * cw
      if v > 0 {
        let o0 = (0 - amin) / (amax - amin)
        let o1 = (v - amin) / (amax - amin)
        rect(P(cx - bw / 2 - 0.5, y-of(0)), P(cx + bw / 2 + 0.5, y-of(v) - 0.5), stroke: none,
          fill: bar-fill(o0, o1))
      }
      if calc.rem(i, k) == 0 {
        content(P(cx, bottom + 11 + top-to-base), anchor: "south", canvas-text(labels.at(i), unit))
      }
    }
  })
}

// Europe/Amsterdam month and year of a UTC millisecond timestamp (EU summer time rules).
#let ams-month-year(ms) = {
  let dt = datetime(year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0) + duration(
    seconds: int(calc.floor(ms / 1000)))
  let y = dt.year()
  let last-sunday(m) = {
    let d = datetime(year: y, month: m, day: 31, hour: 1, minute: 0, second: 0)
    d - duration(days: calc.rem(d.weekday(), 7))
  }
  let summer = dt >= last-sunday(3) and dt < last-sunday(10)
  let local = dt + duration(hours: if summer { 2 } else { 1 })
  (months-short.at(local.month() - 1), str(local.year()))
}
#let date-ms(s) = {
  let p = s.slice(0, 10).split("-").map(int)
  (datetime(year: p.at(0), month: p.at(1), day: p.at(2)) - datetime(year: 1970, month: 1, day: 1)).seconds() * 1000
}

// Scatter chart (ScatterChart.vue: bubble + trendline): 716 x 358 canvas px. pandzakking.md §5.
#let scatter-chart(points, title, axis-title, width) = context {
  let W = 716
  let H = 358
  let unit = width / W
  let label-grey = rgb("#808c99")
  let xs = points.map(p => p.at(0))
  let ys = points.map(p => p.at(1))
  let top = 34
  let bottom = calc.round(358 - (8 + 3 + 2 * 14.4 + 3))
  let (ylo, yhi) = value-range(ys)
  let yt = gen-ticks(ylo, yhi, calc.min(11, calc.ceil((bottom - top) / 14.4)), precision: 0)
  let yl = yt.map(t => nl-int(t))
  let label-w = calc.max(..yl.map(l => measure(canvas-text(l, unit)).width / unit))
  let left = 14.4 + 4 + 4 + label-w + 3 + 8
  let right = W - 16
  let (xlo, xhi) = value-range(xs, zero: false)
  let xt = gen-ticks(xlo, xhi, calc.min(11, calc.ceil((right - left) / 40)))
  let x-of(v) = left + (v - xt.first()) / (xt.last() - xt.first()) * (right - left)
  let y-of(v) = bottom - (v - yt.first()) / (yt.last() - yt.first()) * (bottom - top)
  // least squares over all points (chartjs-plugin-trendline), drawn from the first to the last x
  let n = points.len()
  let mx = xs.sum() / n
  let my = ys.sum() / n
  let sxx = xs.map(x => (x - mx) * (x - mx)).sum()
  let sxy = points.map(p => (p.at(0) - mx) * (p.at(1) - my)).sum()
  let slope = if sxx == 0 { 0 } else { sxy / sxx }
  let f(x) = my + slope * (x - mx)
  cetz.canvas(length: unit, {
    import cetz.draw: *
    let P(x, y) = (x, -y)
    let line1 = (paint: grid-grey, thickness: unit)
    rect(P(0, 0), P(W, H), stroke: none, fill: none)
    content(P(W / 2, 10 + 7.2 + mid-to-base), anchor: "south", canvas-text(title, unit, weight: 800))
    content(P(4 + 7.2, (top + bottom) / 2), anchor: "center", angle: 90deg, canvas-text(axis-title, unit))
    for (i, t) in yt.enumerate() {
      let y = y-of(t)
      line(P(left - 8, y), P(right, y), stroke: if i == 0 { (paint: axis-grey, thickness: unit) } else { line1 })
      content(P(left - 11, y), anchor: "east", canvas-text(yl.at(i), unit, fill: label-grey))
    }
    for (i, t) in xt.enumerate() {
      let x = x-of(t)
      line(P(x, top), P(x, bottom + 8), stroke: if i == 0 { (paint: axis-grey, thickness: unit) } else { line1 })
      let (m, y) = ams-month-year(t)
      content(P(x, bottom + 11 + top-to-base), anchor: "south", canvas-text(m, unit, fill: label-grey))
      content(P(x, bottom + 11 + 14.4 + top-to-base), anchor: "south", canvas-text(y, unit, fill: label-grey))
    }
    for (x, y) in points {
      circle(P(x-of(x), y-of(y)), radius: 2.5, fill: blue-900, stroke: none)
    }
    if n > 0 {
      let (x0, x1) = (calc.min(..xs), calc.max(..xs))
      line(P(x-of(x0), y-of(f(x0))), P(x-of(x1), y-of(f(x1))), stroke: (paint: blue-500, thickness: 2 * unit))
    }
  })
}

// ---- the Incidenten map (incidenten.md §4): map.ts's base map (prefix.svg + prefix.labels.json, 717 x 319 map
// px at zoom 10, drawn by src/lib/report-pdf/map.ts in overview mode), the districts with meldingen (incident_map, from the incident_district tiles), the
// pand as the old map's double ring. Shown like the old snapshot: object-fit cover in a 495:220 box.
#let district-colors = ((1, rgb("#c1d4e6")), (3, rgb("#91bad6")), (5, rgb("#528aad")), (10, rgb("#1e3f67")))
#let district-color(n) = {
  let st = district-colors
  if n <= st.first().at(0) { return st.first().at(1) }
  for i in range(1, st.len()) {
    let (v1, c1) = st.at(i)
    let (v0, c0) = st.at(i - 1)
    if n <= v1 {
      let t = (n - v0) / (v1 - v0)
      return color.mix((c0, (1 - t) * 100%), (c1, t * 100%), space: rgb)
    }
  }
  st.last().at(1)
}
#let incident-map(m, base, width) = {
  let W = 717
  let H = 319
  let s = width / W // pt per map px
  let height = width * 220 / 495
  let dy = (height - H * s) / 2
  let lab = json(base + ".labels.json")
  block(width: width, height: height, clip: true, {
    place(dy: dy, image(base + ".svg", width: width))
    if m != none {
      let (x0, y0, x1, y1) = m.bbox_3857
      let cx = (x0 + x1) / 2
      let cy = (y0 + y1) / 2
      let k = s / m.m_per_px
      let pt(c) = ((c.at(0) - cx) * k + width / 2, (cy - c.at(1)) * k + H * s / 2)
      for dist in m.districts {
        // the fill, one shape per polygon: a district's pieces from two tiles overlap along the tile edge, and
        // even-odd over all of them would cut the overlap out
        for poly in dist.geometry.coordinates {
          let parts = ()
          for ring in poly {
            parts.push(curve.move(pt(ring.first())))
            for c in ring.slice(1) { parts.push(curve.line(pt(c))) }
            parts.push(curve.close())
          }
          place(dy: dy, curve(fill: district-color(dist.incident_count), fill-rule: "even-odd", stroke: none, ..parts))
        }
        // the white border, without the lines where a tile cut the district (map.ts borderLines)
        for line in dist.edges.coordinates {
          place(dy: dy, curve(stroke: 0.5pt + white, curve.move(pt(line.first())),
            ..line.slice(1).map(c => curve.line(pt(c)))))
        }
      }
    }
    // street names from map.ts (none at zoom 10 with the zoom-14 data), as lib.typ's map-box draws them
    for l in lab.labels {
      for layer in ((fill: rgb("#fbf8f1"), stroke: 2.6 * s + rgb("#fbf8f1")), (fill: rgb("#8c6e3a"), stroke: none)) {
        place(dx: l.x * s, dy: dy + l.y * s, place(center + horizon, rotate(l.angle * 1deg, reflow: false,
          text(size: lab.size * s * 1.1, weight: 400, ..layer, l.text))))
      }
    }
    // pandMarker ring: white r 7.5–13.5, navy r 9–12 (map px)
    place(dx: width / 2, dy: dy + H * s / 2, place(center + horizon, circle(radius: 10.5 * s, stroke: 6 * s + white)))
    place(dx: width / 2, dy: dy + H * s / 2, place(center + horizon, circle(radius: 10.5 * s, stroke: 3 * s + blue-900)))
  })
}
