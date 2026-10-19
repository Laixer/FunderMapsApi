// Chapter "Pand" (BuildingChapter.vue): intro and five definition rows.
#import "../lib.typ": *

#let pand(front) = {
  let a = front.analysis
  let address = full-address(front.building_info)
  // "Onderbouw" comes from the sample pickFoundationEntry picks (data-front.sql derived.foundation_sample_id)
  let sid = front.derived.at("foundation_sample_id", default: none)
  let sample = front.report.inquiry_samples.find(s => s.id == sid)
  let sub = if sample == none { none } else { sample.at("substructure", default: none) }
  chapter("Pand", icon: "building", gap: 20 * px, {
    txt(text(fill: ink)[Dit hoofdstuk toont de basisgegevens van uw pand uit de Basisregistratie Adressen en
      Gebouwen (BAG): adres, oppervlakte, hoogte en het BAG-pandnummer. Deze gegevens vormen de basis voor de
      risicobeoordelingen verderop in het rapport.])
    v(28 * px)
    definition-list((
      ("Adres", if address == "" { "Geen adres bekend" } else { address }),
      ("Vloeroppervlak", field(a.at("surface_area", default: none), fmt: to-square-m)),
      ("Pandhoogte", field(a.at("height", default: none), fmt: to-meters)),
      ("Onderbouw", field(sub, fmt: v => substructure-label.at(v, default: no-data))),
      ("BAG ID", field(a.at("building_id", default: none))),
    ))
  })
}
