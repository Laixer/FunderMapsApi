// Chapter "Rapportage" (ReportingChapter.vue). The bar chart's counts come from
// data.statistics_product_inquiries, as in the Vue report: sample rows per year. With the "reports-distinct" fix,
// reports per year (back.sql total_report_count_distinct).
#import "../lib-back.typ": *

#let rapportage-shown(d) = (arr(d.back.report.at("inquiries", default: none)).len() > 0
  or arr(d.back.statistics.at("total_report_count", default: none)).len() > 0)

// table.w-full, auto layout: columns share the width in proportion to their widest cell (as Chromium measures
// it: cr-width, whole-px glyph advances — matches the old column positions to 0.07 pt); 10-px cell padding,
// 18-px lines, a 1-px #e8eaf1 rule under every body row but the last; header black, body grey.
#let report-table(reports) = context layout(size => {
  let head = ("Nummer", "Type", "Datum")
  let body = reports.map(r => (
    str(r.id),
    inquiry-type-label.at(str(r.at("type", default: "")), default: ""),
    if is-date(r.at("document_date", default: none)) { date-dmy(r.document_date) } else { "" },
  ))
  let widths = range(3).map(c => {
    let cells = (head.at(c),) + body.map(row => row.at(c))
    calc.max(..cells.map(t => cr-width(t)))
  })
  let total = widths.sum()
  let cell(t, rule, fill) = block(width: 100%, {
    block(inset: (y: px(10)), text(fill: fill, t))
    if rule { block(width: 100%, height: px(1), fill: grey-200) }
  })
  let n = body.len()
  grid(columns: widths.map(w => w / total * size.width), gutter: 0pt,
    grid.header(..head.map(t => cell(t, false, black))),
    ..body.enumerate().map(((i, row)) => row.map(t => cell(t, i < n - 1, ink))).flatten(),
  )
})

#let rapportage(d) = {
  let reports = sorted-inquiries(d.back.report)
  let trc = arr(d.back.statistics.at(
    if fixed("reports-distinct") { "total_report_count_distinct" } else { "total_report_count" }, default: none))
  let content = {
    back-header("Rapportage", icon: "file-report")
    para("Onder de risicobeoordelingen in dit rapport liggen onderzoeksrapportages voor uw pand of voor panden in de directe omgeving. Hieronder vindt u welke rapportages zijn meegenomen, en hoeveel onderzoeken er per jaar in uw wijk zijn uitgevoerd – meer onderzoeken in uw buurt geven over het algemeen een betrouwbaardere modelinschatting.")
    gap(28)
    para(if reports.len() == 1 { "De volgende rapportage is beschikbaar voor dit pand en is gebruikt voor het opstellen van het funderingsrisicorapport." } else if reports.len() > 1 { "De volgende rapportages zijn beschikbaar voor dit pand en zijn gebruikt voor het opstellen van het funderingsrisicorapport." } else { "Voor dit pand zelf zijn geen onderzoeksrapportages bekend." })
    if reports.len() > 0 {
      gap(28)
      report-table(reports)
    }
    if trc.len() > 0 {
      gap(28)
      layout(size => bar-chart(
        trc.map(r => if r.year == none { "null" } else { str(r.year) }),
        trc.map(r => int(r.count)),
        "Aantal rapportages in de wijk per jaar", size.width))
    }
  }
  // one piece (break-inside: avoid) — unless it is taller than a page: then Chromium splits the table at its
  // rows and repeats the header row (grid.header does that).
  layout(size => {
    let h = measure(block(width: size.width, content)).height
    let page-h = if size.height.pt() < 1e6 { size.height } else { 742.92pt }
    block(breakable: h > page-h, content)
  })
}
