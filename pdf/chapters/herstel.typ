// Chapter "Funderingsherstel" (FoundationRestorationChapter.vue).
// Shows only the first recovery entry: the first recovery in API order (the record whose document was edited
// last) and its first sample of this pand — not the latest herstel.
#import "../lib-back.typ": *

#let herstel(d) = {
  let entries = recovery-entries(d.back.report)
  let s = if entries.len() > 0 { entries.first().sample } else { none }

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
