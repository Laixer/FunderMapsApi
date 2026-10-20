// The risk chapter's closing block "Risicoverdeling van de wijk" (FoundationRiskChapter.vue 341-366).
// The pie draws data.statistics_product_foundation_risk, as the Vue report does: each pand's lowest class. With
// the "risk-highest" fix, its highest class (back.sql foundation_risk_distribution_highest), as the text says.
#import "../lib-back.typ": *

#let risk-colors = (rgb("#2E7D32"), rgb("#9E9D24"), rgb("#F9A825"), rgb("#EF6C00"), rgb("#C62828"))

#let risk-pie-block(d) = {
  let key = if fixed("risk-highest") { "foundation_risk_distribution_highest" } else { "foundation_risk_distribution" }
  let dist = arr(d.back.statistics.at(key, default: none))
  let values = ("a", "b", "c", "d", "e").map(k => {
    let r = dist.find(r => r.foundation_risk == k)
    if r == none { 0 } else { float(r.percentage) }
  })
  // last child of the chapter's section.space-y-7; kept in one piece (break-inside: avoid)
  wgap(28)
  layout(size => {
    let w = size.width
    let pie-w = span(w, 3)
    block(breakable: false, grid(columns: (span(w, 5), pie-w, span(w, 4)), column-gutter: px(16),
      align: (left + top, left + top, left + horizon),
      {
        block-b(fill: grey-800)[Risicoverdeling van de wijk op basis van risicomodellen]
        gap(8)
        para("In deze grafiek is per pand het hoogste risico bepaald uit de verschillende risicomodellen. Deze maximale risicowaarden zijn vervolgens gebruikt om de risicoverdeling in de hele wijk in kaart te brengen, waarbij de verhoudingen zijn weergegeven in de bijgaande grafiek.")
      },
      pie(values, risk-colors, 167, pie-w),
      legend-list("Verdeling van funderingsrisico in de wijk", (
        (risk-colors.at(0), "A (Geen risico)"), (risk-colors.at(1), "B (Laag risico)"),
        (risk-colors.at(2), "C (Verhoogd risico)"), (risk-colors.at(3), "D (Hoog risico)"),
        (risk-colors.at(4), "E (Aanzienlijk hoog risico)"),
      )),
    ))
  })
}
