// Chapter "Samenvatting" (CoverSummary.vue): five definition rows and the print date.
#import "../lib.typ": *

// front = data-front.sql's object; date = the render date "YYYY-MM-DD" (Europe/Amsterdam)
#let samenvatting(front, date) = {
  let a = front.analysis
  let address = full-address(front.building_info)
  // the worst of the four risks; "Geen data" when all are null
  let risks = ("drystand_risk", "dewatering_depth_risk", "bio_infection_risk", "unclassified_risk")
    .map(k => a.at(k, default: none)).filter(has)
  let highest = if risks.len() == 0 { "Geen data" } else { risk-label.at(risks.sorted().last()) }
  let year = a.at("construction_year", default: none)
  let ftype = a.at("foundation_type", default: none)
  chapter("Samenvatting", icon: "home-info", gap: 20 * px, {
    definition-list((
      ("Adres", if address == "" { "Geen adres bekend" } else { address }),
      // printed as is: BAG's "unknown" year 1005 shows as 1005 (kept, as today)
      ("Bouwjaar", if year == none { "—" } else { str(year) }),
      ("Funderingstype", if ftype == none { "—" } else { foundation-type-label.at(ftype, default: "—") }),
      ("Hoogste risicocategorie", highest),
      ("BAG ID", if has(a.at("building_id", default: none)) { a.building_id } else { front.at("pand", default: "—") }),
    ))
    v(28 * px)
    txt(text(fill: ink, "Gegenereerd op " + date-nl(date)))
  })
}
