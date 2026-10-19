// Chapter "Locatie" (LocationChapter.vue): intro, the location map, the grey Omgeving box.
#import "../lib.typ": *

// ItemGrid label: the part before "(" Regular, the bracket part RegularOblique and never broken inside
#let grid-label(label) = {
  let i = label.position("(")
  if i == none { label } else { label.slice(0, i) + box(emph(label.slice(i))) }
}
// ItemGrid rows: a 2-column grid per field (16 px gap), 3 px padding above and below 18 px lines, no gap between
#let item-grid(rows) = for (label, value) in rows {
  grid(columns: (1fr, 1fr), column-gutter: 16 * px, inset: (y: 3 * px), grid-label(label), text(fill: ink, value))
}

// front = data-front.sql's object; map = map.ts output prefix ("/maps/<pand>-location")
#let locatie(front, map) = {
  let a = front.analysis
  let soil = a.at("soil", default: none)
  // the model (analysis)
  let model = (
    ("Type ondergrond", field(soil, fmt: s => soil-label.at(s, default: s))),
    ("Maaiveldniveau (volgens AHN)", field(a.at("ground_level", default: none), fmt: to-nap)),
    ("Grondwaterstand volgens landelijk watermodel", field(a.at("ground_water_level", default: none), fmt: to-maaiveld)),
  )
  // the newest report's sample (inquiryData[0].sample = derived.location_sample_id), even when it is empty: kept
  let sid = front.derived.at("location_sample_id", default: none)
  let s = front.report.inquiry_samples.find(x => x.id == sid)
  let sv(k) = if s == none { none } else { s.at(k, default: none) }
  let sample = (
    ("Sondering", field(sv("cpt"))),
    ("Maaiveldniveau (uit onderzoek)", field(sv("groundlevel"), fmt: to-nap)),
    ("Grondwaterstand (uit peilbuis)", field(sv("groundwater_level_net"), fmt: to-nap)),
    ("Peilbuis", field(sv("monitoring_well"))),
    ("Grondwaterniveau bij ontgraving", field(sv("groundwater_level_temp"), fmt: to-nap)),
  )
  let two = sample.any(r => r.at(1) != no-data)
  chapter("Locatie", icon: "pin", gap: 20 * px, {
    txt(text(fill: ink)[De ondergrond bepaalt grotendeels het funderingsrisico van een pand. Hieronder ziet u welk
      type bodem onder uw pand zit en hoe diep het grondwater staat. Een lage grondwaterstand vergroot
      bijvoorbeeld het risico op houtrot bij houten paalfunderingen.])
    v(28 * px)
    // div.aspect-map (495 : 220 of the 700 px column = 311 px)
    map-box(json(map + ".labels.json"), map + ".svg", height: 311 * px)
    v(28 * px)
    highlight({
      // h3 11 px ExtraBold in a 12 px line, baseline 10 px down; then space-y-3
      txt(text(size: 11 * px, weight: 800, top-edge: 10 * px, bottom-edge: -2 * px, "Omgeving")) // no tracking: measured
      v(12 * px)
      txt(grid(columns: if two { (1fr, 1fr) } else { (1fr,) }, column-gutter: 16 * px,
        item-grid(model), ..if two { (item-grid(sample),) }))
    })
  })
}
