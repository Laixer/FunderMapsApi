// Chapter "Gevelscan" (FacadeReviewChapter.vue).
// NEVER PRINTED TODAY: the chapter's v-if reads a non-reactive object that is only filled by a computed the
// chapter itself reads, so it is evaluated once as false. back.typ keeps it behind `show-gevelscan: false`;
// this is the intended layout (from the code and CSS — no print exists to measure).
#import "../lib-back.typ": *

#let facade-cells = (
  ("Achtergevel", "achter", "crack_facade_back"),
  ("Inpandige scheur", "inpandig", "crack_indoor"),
  ("Linkerzijgevel", "links", "crack_facade_left"),
  ("Rechterzijgevel", "rechts", "crack_facade_right"),
  ("Voorgevel", "voor", "crack_facade_front"),
)
#let cell-rows(s, key) = (
  ("Hersteld", field(s, key + "_restored")),
  ("Type", field(s, key + "_type", labels: crack-type-label)),
  ("Scheur", field(s, key + "_size", fmt: fmt-mm)),
)
#let skew-left(s) = (
  ("Gevel vervormd", field(s, "deformed_facade")),
  ("Lintvoegmeting beoordeling", field(s, "skewed_parallel_facade", labels: rotation-type-label)),
  ("Lintvoegmeting", field(s, "skewed_parallel", fmt: fmt-scale)),
  ("Drempel voorgevel niveau", field(s, "threshold_front_level", fmt: fmt-nap)),
  ("Scheve deur- en/of raamkozijnen", field(s, "skewed_window_frame")),
)
#let skew-right(s) = (
  ("Ongelijkmatige zakking?", field(s, "threshold_updown_skewed")),
  ("Loodmeting beoordeling", field(s, "skewed_perpendicular_facade", labels: rotation-type-label)),
  ("Loodmeting", field(s, "skewed_perpendicular", fmt: fmt-scale)),
  ("Drempel achtergevel niveau", field(s, "threshold_back_level", fmt: fmt-nap)),
  ("Pandzakkingssnelheid gemeten", field(s, "settlement_speed", fmt: fmt-mm-year)),
)
#let group-has-data(rows) = rows.any(r => r.at(1) != no-data)

// The entry shown: the first inquiry entry (newest report, its first sample) — no search for facade values.
#let gevelscan-sample(d) = {
  let e = inquiry-entries(d.back.report)
  if e.len() == 0 { none } else { e.first().sample }
}
#let gevelscan-shown(d) = {
  let s = gevelscan-sample(d)
  s != none and (facade-cells.any(c => group-has-data(cell-rows(s, c.at(2))))
    or group-has-data(skew-left(s)) or group-has-data(skew-right(s)))
}

// One cell: figure (col-span-2 of grid-cols-6, square, border, padding 8 px, icon + caption) and three
// ItemGrid rows (col-span-4), vertically centred.
#let facade-cell(s, cell, w) = {
  let (caption, icon, key) = cell
  let col = span(w, 1, cols: 6)
  let fig = span(w, 2, cols: 6)
  let inner = fig - px(2) - px(16)
  grid(columns: (fig, span(w, 4, cols: 6)), column-gutter: px(16), align: (left + top, left + horizon),
    block(width: fig, height: fig, {
      place(dx: px(.5), dy: px(.5), rect(width: fig - px(1), height: fig - px(1), radius: px(3.5),
        stroke: px(1) + grey-400))
      place(dx: px(9), dy: px(9), block(width: inner, height: inner, {
        let cap = align(center, text(weight: 800, fill: ink, top-edge: px(11), bottom-edge: -px(5), caption))
        context {
          let ch = measure(block(width: inner, cap)).height
          place(center + top, image("/assets/icons/print/facade-" + icon + ".svg", height: inner - ch - px(4),
            fit: "contain"))
          place(bottom, block(width: inner, cap))
        }
      }))
    }),
    { for (l, v) in cell-rows(s, key) { item-grid(l, v) } },
  )
}

#let gevelscan(d) = {
  let s = gevelscan-sample(d)
  back-header("Gevelscan", icon: "scan")
  para("De gevelscan registreert zichtbare aanwijzingen van funderingsproblematiek aan de buitenkant van het pand: scheurvorming, scheefstand en vervorming. Een lintvoegmeting registreert horizontale vervorming, een loodmeting verticale scheefstand. Deze metingen vullen de modelmatige risicobeoordelingen aan met directe waarnemingen op locatie.")
  if facade-cells.any(c => group-has-data(cell-rows(s, c.at(2)))) {
    gap(28)
    layout(size => {
      let half = (size.width - px(16)) / 2
      grid(columns: (half, half), column-gutter: px(16), row-gutter: px(16),
        ..facade-cells.map(c => facade-cell(s, c, half)))
    })
  }
  if group-has-data(skew-left(s)) or group-has-data(skew-right(s)) {
    gap(28)
    highlight({
      h3[Vervorming]
      gap(12)
      grid(columns: (1fr, 1fr), column-gutter: px(16),
        { for (l, v) in skew-left(s) { item-grid(l, v) } },
        { for (l, v) in skew-right(s) { item-grid(l, v) } },
      )
    })
  }
}
