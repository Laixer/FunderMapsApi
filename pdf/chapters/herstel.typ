// Chapter "Funderingsherstel" (FoundationRestorationChapter.vue).
// Shows only the first recovery entry: the first recovery in API order (the record whose document was edited
// last) and its first sample of this pand — not the latest herstel. With the "herstel-latest" fix: among the
// entries with a herstel date (the sample's recovery_date) the latest; when none has one, among those with a known
// type the latest document date of the record; API order on a tie. (A document date alone is no herstel date:
// bulk-imported records with a recent document date and type "unknown" would otherwise win over a real herstel.)
#import "../lib-back.typ": *

#let herstel-day(e) = {
  let r = if e.sample == none { none } else { e.sample.at("recovery_date", default: none) }
  if is-date(r) { r.slice(0, 10) } else { none }
}
#let document-day(e) = {
  let dd = e.recovery.at("document_date", default: none)
  if is-date(dd) { dd.slice(0, 10) } else { "" }
}

#let herstel(d) = {
  let entries = recovery-entries(d.back.report)
  let pick = if entries.len() == 0 { none } else if fixed("herstel-latest") {
    let dated = entries.filter(e => herstel-day(e) != none)
    let typed = entries.filter(e => e.sample != none and e.sample.at("type", default: none) not in (none, "unknown"))
    let (pool, day) = if dated.len() > 0 { (dated, herstel-day) }
      else if typed.len() > 0 { (typed, document-day) } else { (entries, document-day) }
    let latest = pool.map(day).sorted().last()
    pool.find(e => day(e) == latest)
  } else { entries.first() }
  let s = if pick == none { none } else { pick.sample }

  back-header("Funderingsherstel", icon: "wrench")
  para("Hieronder ziet u of er voor dit pand herstel van de fundering is geregistreerd, en zo ja, welk type en wanneer. Een eerder herstel kan duiden op eerdere problematiek; de huidige risicobeoordelingen verderop in het rapport gelden onafhankelijk daarvan.")
  gap(16)
  para("De gegevens hieronder zijn afkomstig uit het Nationaal Herstel Register.")
  gap(28)

  let first = item-grid("Funderingsherstel", b(text(fill: black,
    if s == none { "Geen herstel geregistreerd" } else { "Ja" })))
  if s == none {
    grid(columns: (1fr, 1fr), column-gutter: px(16), first)
  } else {
    let facades = s.at("facade", default: none)
    let where = if facades == none or facades.len() == 0 { no-data } else {
      facades.map(f => facade-label.at(f, default: "")).join(", ")
    }
    let date = s.at("recovery_date", default: none)
    grid(columns: (1fr, 1fr), column-gutter: px(16),
      { first; item-grid("Locatie herstel", where) },
      {
        item-grid("Type herstel", field(s, "type", labels: recovery-type-label))
        item-grid("Datum hersteld", if is-date(date) { date-dmy(date) } else { no-data })
      },
    )
  }
}
