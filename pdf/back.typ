// The back half of the funderingsrisicorapport: three entry points, each taking the merged data
// d = (pand, front, back): the merged data of src/lib/report-pdf/data.ts.
//
//   middle-back(d)  Fundering + Funderingsherstel (one page in the old PDF; the caller puts the page breaks
//                   around it). Ends without a trailing gap.
//   risk-pie(d)     the risk chapter's closing block; starts with the chapter's 28-px (weak) gap and is kept in
//                   one piece, so it moves to the next page whole when it does not fit.
//   end-back(d)     Rapportage, [Gevelscan], Pandzakking, Incidenten, page break, Aanvullend onderzoek,
//                   Disclaimer. Starts with the 40-px (weak) gap that follows the risk chapter.
//
// Everything is set inside back-type (lib-back.typ): 12-px body (8.134 pt) with Chromium's line boxes and explicit
// gaps, so the caller's text and paragraph settings do not shift it. Needs the Incidenten base map
// maps/<pand>-incidents.{svg,labels.json} (incident-map.sh <pand>; or --input incident-map=/path/prefix).
#import "lib-back.typ": back-type, wgap, px
#import "chapters/fundering.typ": fundering
#import "chapters/herstel.typ": herstel
#import "chapters/risk-pie.typ": risk-pie-block
#import "chapters/rapportage.typ": rapportage, rapportage-shown
#import "chapters/gevelscan.typ": gevelscan, gevelscan-shown
#import "chapters/pandzakking.typ": pandzakking, pandzakking-shown
#import "chapters/incidenten.typ": incidenten
#import "chapters/slot.typ": aanvullend-onderzoek, disclaimer

// Gevelscan is off, as in the Vue report, unless the "gevelscan" fix is on (lib-back.typ `fixes`).
#import "lib-back.typ": fixed
#let show-gevelscan = fixed("gevelscan")

#let middle-back(d) = back-type({
  fundering(d)
  wgap(40)
  herstel(d)
})

#let risk-pie(d) = back-type(risk-pie-block(d))

#let end-back(d, show-gevelscan: show-gevelscan) = back-type({
  if rapportage-shown(d) {
    wgap(40)
    rapportage(d)
  }
  if show-gevelscan and gevelscan-shown(d) {
    wgap(40)
    gevelscan(d)
    pagebreak(weak: true)
  }
  if pandzakking-shown(d) {
    wgap(40)
    pandzakking(d)
    pagebreak(weak: true)
  }
  wgap(40)
  incidenten(d)
  pagebreak(weak: true)
  aanvullend-onderzoek()
  wgap(40)
  disclaimer()
})
