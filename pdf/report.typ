// The FunderMaps funderingsrisicorapport in Typst, without a browser.
//   typst compile --root . --font-path assets/fonts --package-cache-path packages \
//     --input data=/data/<pand>.report.json --input map=/maps/<pand> --input date=YYYY-MM-DD report.typ out.pdf
// data: {pand, front, back} (src/lib/report-pdf/render.ts); map: the map.ts prefix (<map>-location for Locatie, <map>-year for Bouwjaar);
// date: the render date in Europe/Amsterdam ("Gegenereerd op", and the chart's "vanaf" decade).
// Order and page breaks as src/views/PDF.vue.
#import "lib.typ": *
#import "chapters/cover.typ": cover-band
#import "chapters/samenvatting.typ": samenvatting
#import "chapters/leeswijzer.typ": leeswijzer
#import "chapters/pand.typ": pand
#import "chapters/locatie.typ": locatie
#import "chapters/bouwjaar.typ": bouwjaar
#import "chapters/risk.typ": risk-chapter
#import "back.typ": middle-back, risk-pie, end-back
#let d = json(sys.inputs.at("data"))
#let front = d.front
#let back = d.back
#let date = sys.inputs.at("date", default: datetime.today().display("[year]-[month]-[day]"))
#let map = sys.inputs.at("map", default: "/maps/" + d.pand)

// The Vue report renders nothing (and Gotenberg makes no PDF) unless all its API answers are there.
#if front.at("missing", default: ()).len() > 0 {
  panic("no report for " + d.pand + ": missing " + front.missing.join(", "))
}

#let address = full-address(front.building_info)
#set document(
  title: "Funderingsrisicorapport " + (if address == "" { "" } else { address + " " }) + "– FunderMaps",
  author: "FunderMaps",
)
// Chromium's A4 and the old print's frame (lib.typ); px-page puts the front chapters on the same column.
#set page(width: page-width, height: page-height,
  margin: (left: page-margin-left, right: page-margin-right, top: page-margin-top, bottom: page-margin-bottom))
#set text(font: "Greycliff CF", size: 8.06pt, lang: "nl", fill: black)
#set par(leading: 0.81em, spacing: 2.15em, justify: false)
#set strong(delta: 400)

// page 1: cover band + Samenvatting (40 px after every top-level block of the .a4 page)
#px-page({
  cover-band()
  v(40 * px)
  samenvatting(front, date)
})
#pagebreak()
// page 2
#px-page(leeswijzer())
#pagebreak()
// page 3: Pand + Locatie
#px-page({
  pand(front)
  v(40 * px)
  locatie(front, map + "-location")
})
// page 4: Fundering + Funderingsherstel
#pagebreak()
#middle-back(d)
#pagebreak()
// Bouwjaar, its own page
#px-page(bouwjaar(front, map + "-year", date))
#pagebreak()
#px-page(risk-chapter(front.analysis))
#risk-pie(d)
// Rapportage, Gevelscan (off, as today), Pandzakking, Incidenten, page break, Aanvullend onderzoek, Disclaimer
#end-back(d)
