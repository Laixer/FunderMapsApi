// Chapter "Fundering" (InquirySampleChapter.vue).
#import "../lib-back.typ": *

// The five fields that make a sample "have foundation data" (an enum without a label counts as empty).
#let foundation-fields(s) = (
  enforcement_term: field(s, "enforcement_term", labels: enforcement-term-label),
  damage_characteristics: field(s, "damage_characteristics", labels: damage-characteristics-label),
  overall_quality: field(s, "overall_quality", labels: foundation-quality-label),
  damage_cause: field(s, "damage_cause", labels: damage-cause-label),
  substructure: field(s, "substructure", labels: substructure-label),
)
#let has-foundation-data(s) = s != none and foundation-fields(s).values().any(has-value)

// A list field: with more than one entry all labels joined (unknown ones dropped), else the single field.
#let list-or-field(s, key, labels) = {
  let list = if s == none { none } else { s.at(key + "_list", default: none) }
  if list != none and list.len() > 1 {
    list.map(v => labels.at(str(v), default: none)).filter(l => l != none).join(", ")
  } else { field(s, key, labels: labels) }
}

#let foundation-icon(t) = {
  if t in ("wood", "wood_amsterdam", "wood_rotterdam", "wood_rotterdam_amsterdam", "wood_rotterdam_arch",
    "wood_amsterdam_arch") { "houten-palen" }
  else if t in ("concrete", "weighted_pile", "combined", "steel_pile") { "betonnen-palen" }
  else if t != none and t.starts-with("no_pile") { "niet-onderheid" }
  else if t == "wood_charger" { "houten-palen-oplanger" }
  else { none }
}

#let explanation = (
  "houten-palen": "Bij een fundering op houten palen wordt het gebouw gedragen door verticale houten palen die diep in de grond zijn aangebracht. Deze palen reiken doorgaans tot een draagkrachtige zandlaag en zijn bedoeld om de constructie te ondersteunen in slappe of natte bodems. De palen blijven in goede staat zolang ze onder de grondwaterstand blijven en er daardoor geen zuurstof bij komt.",
  "betonnen-palen": "Bij een fundering op betonpalen wordt de belasting van het gebouw overgedragen aan de ondergrond via betonnen palen die diep in de bodem zijn geheid. Deze funderingsvorm is veelal toegepast bij zwaardere constructies of in gebieden waar de draagkrachtige laag zich op grotere diepte bevindt. Betonpalen zijn duurzaam, bestand tegen vocht en bacteriële aantasting, en kennen doorgaans geen funderingsproblematiek.",
  "houten-palen-oplanger": "Een fundering op houten palen met oplanger bestaat uit houten palen die zijn verlengd met een betonnen opzetstuk (de oplanger). Deze oplanger zorgt ervoor dat de paalkop dieper onder het maaiveld – en idealiter onder de grondwaterstand – komt te liggen. Het doel hiervan is om het hout te beschermen tegen zuurstof en daarmee tegen aantasting, zoals rot. Deze methode werd vaak toegepast bij latere aanpassingen of bij hersteldelen in bestaande bebouwing.",
  "niet-onderheid": "Een ondiepe fundering – vaak aangeduid als fundering op staal – is een funderingsvorm waarbij het pand direct op een draagkrachtige grondlaag rust, zoals zand of vaste klei. De belasting van het gebouw wordt via funderingsstroken of poeren verspreid over de ondergrond. Deze methode is geschikt op locaties waar de draagkrachtige laag zich dicht bij het maaiveld bevindt. In slappe of ongelijkmatige bodems is er echter meer risico op zettingen of scheefstand. In het verleden is dit funderingstype veelvuldig toegepast in gebieden met beperkte draagkracht.",
)

// The neighbourhood pie: 5 buckets (the 5th, other/unknown, is drawn in bucket 0's red and has no legend entry).
#let ft-colors = (rgb("#CE0015"), rgb("#6A6C70"), rgb("#8F7A2E"), rgb("#8C3A28"))
#let ft-bucket(t) = {
  if t != none and t.starts-with("no_pile") { 0 }
  else if t in ("concrete", "weighted_pile", "combined", "steel_pile") { 1 }
  else if t == "wood_charger" { 2 }
  else if t in ("wood", "wood_amsterdam", "wood_rotterdam", "wood_rotterdam_amsterdam", "wood_rotterdam_arch",
    "wood_amsterdam_arch") { 3 }
  else { 4 }
}

// The figure (col-span-3, square): 1-px #ced0da border, radius 4 px, padding 16 px; the icon 2/3 of the inner
// width, centred above the ExtraBold caption (16-px lines, at the bottom of the inner box).
#let figure-box(icon, caption, side) = context {
  let inner = side - px(2) - px(32)
  let cap = block(width: inner, {
    set text(top-edge: px(11), bottom-edge: -px(5))
    para(caption, weight: 800, align: center)
  })
  let cap-h = measure(cap).height
  let icon-w = inner * 2 / 3
  let room = inner - cap-h - px(4)
  block(width: side, height: side, {
    place(dx: px(.5), dy: px(.5), rect(width: side - px(1), height: side - px(1), radius: px(3.5),
      stroke: px(1) + grey-400))
    place(dx: px(17) + (inner - icon-w) / 2, dy: px(17) + (room - icon-w) / 2,
      image("/assets/icons/print/foundation-" + icon + ".svg", width: icon-w, height: icon-w))
    place(dx: px(17), dy: px(17) + inner - cap-h, cap)
  })
}

#let fundering(d) = {
  let b = d.back
  let a = b.analysis
  let entries = inquiry-entries(b.report)
  let selected = entries.find(e => has-foundation-data(e.sample))
  if selected == none and entries.len() > 0 { selected = entries.first() }
  let s = if selected == none { none } else { selected.sample }
  let selected-is-newest = selected != none and selected.report.id == entries.first().report.id
  let samples-available = entries.filter(e => e.sample != none).len()
  let reports-available = entries.map(e => e.report.id).dedup().len()
  let sample-has-values = has-foundation-data(s)

  back-header("Fundering", icon: "file-foundation")

  if samples-available > 1 or (selected != none and not selected-is-newest) {
    let t = if reports-available == 1 { "Voor dit pand is 1 onderzoeksrapport beschikbaar." } else {
      "Voor dit pand zijn " + str(reports-available) + " onderzoeksrapporten beschikbaar."
    }
    if sample-has-values {
      let dd = selected.report.at("document_date", default: none)
      t += " Hieronder ziet u de gegevens uit het meest recente rapport"
      if not selected-is-newest { t += " waarin deze zijn vastgelegd" }
      if is-date(dd) { t += " (" + date-long(dd) + ")" }
      t += "; het volledige overzicht vindt u in het hoofdstuk ‘Rapportage’."
    } else {
      t += " Het volledige overzicht vindt u in het hoofdstuk ‘Rapportage’."
    }
    para(t)
    gap(28)
  }

  let rows = ((
    "Betrouwbaarheid funderingstype",
    field(a, "foundation_type_reliability", labels: reliability-label-back),
  ),)
  if sample-has-values {
    let f = foundation-fields(s)
    rows += (
      ("Handhavingstermijn", f.enforcement_term),
      ("Geconstateerde schade", list-or-field(s, "damage_characteristics", damage-characteristics-label)),
      ("Totale funderingskwaliteit", f.overall_quality),
      ("Oorzaak funderingsschade", list-or-field(s, "damage_cause", damage-cause-label)),
      ("Onderbouw", f.substructure),
    )
  }
  let rows-block = {
    def-rows(rows)
    if not sample-has-values {
      block(text(fill: ink, top-edge: px(16), bottom-edge: -px(8),
        [Voor dit pand is geen onderzoeksrapport met deze gegevens beschikbaar.]))
    }
  }
  let icon = foundation-icon(a.foundation_type)
  layout(size => {
    let w = size.width
    if icon != none {
      let side = span(w, 3)
      grid(columns: (side, span(w, 9)), column-gutter: px(16),
        figure-box(icon, foundation-type-label.at(a.foundation_type, default: ""), side), rows-block)
    } else {
      block(width: span(w, 9), rows-block)
    }
  })
  if icon != none {
    gap(28)
    para(explanation.at(icon))
  }
  gap(28)

  // neighbourhood pie + legend (grid-cols-12 items-center): pie col-span-5 (282 px tall), legend col-span-7
  let buckets = (0, 0, 0, 0, 0)
  for r in arr(b.statistics.at("foundation_type_distribution", default: none)) {
    let i = ft-bucket(r.foundation_type)
    buckets.at(i) += float(r.percentage)
  }
  layout(size => {
    let w = size.width
    let side = span(w, 5)
    grid(columns: (side, span(w, 7)), column-gutter: px(16), rows: px(282), align: (left + top, left + horizon),
      box(width: side, height: px(282), clip: false, pie(buckets, ft-colors, 289, side)),
      legend-list("Type fundering (wijk)", (
        (ft-colors.at(0), "Ondiepe fundering"), (ft-colors.at(1), "Betonpaal"),
        (ft-colors.at(2), "Houten paal met betonoplanger"), (ft-colors.at(3), "Houten paal"),
      )),
    )
  })
}
