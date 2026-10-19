// Chapter "Pandzakking" (DisplacementDataChapter.vue).
#import "../lib-back.typ": *

#let pandzakking-shown(d) = (d.back.analysis.at("velocity", default: none) != none
  or arr(d.back.at("subsidence_historic", default: none)).len() > 0)

#let pandzakking(d) = {
  let vel = d.back.analysis.at("velocity", default: none)
  let hist = arr(d.back.at("subsidence_historic", default: none))
  // header + section in one piece (break-inside: avoid); section.space-y-10: 40 px between its blocks
  block(breakable: false, {
    back-header("Pandzakking", icon: "graph")
    para("Voor een deel van de panden in Nederland zijn zakkingsgegevens beschikbaar. Deze zijn verkregen op basis van satellietmetingen en bepaald met een zogenaamde InSAR-analyse, waarbij de zakkingssnelheid wordt uitgedrukt in millimeters per jaar (mm/jaar).")
    gap(16)
    para("De meting geeft de mate van zakking aan in een bepaalde periode, maar kan niet direct worden gebruikt om de absolute zakking te bepalen – oftewel hoeveel het pand in totaal is gezakt over de volledige levensduur.")
    gap(16)
    para("De meetresultaten zijn verwerkt in de risicomodellen en dragen bij aan het bepalen van het funderingsrisico per pand.")
    if vel != none {
      gap(40)
      highlight(width: 50%, {
        h3[Pandzakkingsgegevens]
        gap(12)
        item-grid("Pandzakkingssnelheid (InSAR)", fmt-mm-year(vel))
      })
    }
    if hist.len() > 0 {
      gap(40)
      layout(size => scatter-chart(hist.map(h => (date-ms(h.mark_at), float(h.velocity))),
        "Pandzakking (mm)", "mm", size.width))
    }
  })
}
