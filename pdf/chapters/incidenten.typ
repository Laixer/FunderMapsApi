// Chapter "Incidenten" (IncidentsChapter.vue).
// Per-pand meldingen (report.incident) are loaded by the old report but printed nowhere; the map colours the
// districts by the number of panden with an intake dossier (maplayer.incident_district_tiles).
#import "../lib-back.typ": *

#let legend-colors = (rgb("#c1d4e6"), rgb("#91bad6"), rgb("#528aad"), rgb("#38658a"), rgb("#1e3f67"))
#let legend-labels = ("Nauwelijks meldingen", "Enkele meldingen", "Regelmatig meldingen", "Veel meldingen",
  "Zeer veel meldingen")

// MapLegend.vue: grid repeat(5, auto), 8-px gaps, 8-px side padding; the columns take their content width plus an
// equal share of the rest. Item: text 16 px in, an 18-px swatch from 8 px left of the item to 10 px into it.
#let map-legend() = context layout(size => {
  let ws = legend-labels.map(l => px(16) + cr-width(l))
  let free = (size.width - px(16) - px(8) * 4 - ws.sum()) / 5
  let x = px(8)
  block(width: 100%, height: px(18), {
    for (i, l) in legend-labels.enumerate() {
      place(dx: x - px(8), rect(width: px(18), height: px(18), fill: legend-colors.at(i), stroke: none))
      place(dx: x + px(16), text(fill: black, l))
      x += ws.at(i) + free + px(8)
    }
  })
})

#let incidenten(d) = {
  let base = sys.inputs.at("incident-map", default: "/maps/" + d.pand + "-incidents")
  block(breakable: false, {
    back-header("Incidenten", icon: "alert")
    para("In heel Nederland komen meldingen binnen van schade die mogelijk verband houdt met funderingsproblemen, zoals scheuren in gevels, verzakkingen of klemmende deuren en ramen. Deze signalen worden verzameld en geanalyseerd via het Landelijk Loket Funderingsproblematiek van het KCAF. De meldingen worden ontsloten op een gebiedsgerichte kaart, waarvan hieronder een uitsnede is weergegeven voor de omgeving van het pand.")
    gap(40)
    layout(size => incident-map(d.back.at("incident_map", default: none), base, size.width))
    gap(40)
    map-legend()
    gap(40)
    let url = "https://www.kcaf.nl/landelijk-loket-funderingsproblematiek/"
    para(("Het KCAF-loket fungeert als centraal meldpunt voor bewoners, woningcorporaties en gemeenten die vermoedens hebben van funderingsschade. Heeft u schade, vermoedt u funderingsproblemen of wilt u meer informatie? Dan kunt u kosteloos een melding doen via: \n", (t: url, url: url, fill: link-green)))
    gap(16)
    layout(size => {
      let col = size.width / 12
      grid(columns: (col * 10, col * 2), column-gutter: 0pt,
        para("Het KCAF is een onafhankelijke stichting die woningeigenaren, corporaties en gemeenten ondersteunt bij het verkrijgen van grip op funderingsproblematiek. Uw melding draagt bij aan beter landelijk inzicht in de aard en omvang van funderingsrisico's en kan het startpunt vormen voor verder onderzoek of passende ondersteuning."),
        image("/assets/img/Logo-KCAF.png", width: px(54.4)),
      )
    })
  })
}
