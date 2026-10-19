// Chapter "Bouwjaar" (ConstructionYearChapter.vue): intro, the bar chart of the neighbourhood's
// building years (cetz, laid out like the Chart.js canvas), a flat map of the building years, the legend.
#import "../lib.typ": *
#import "@preview/cetz:0.4.2"

// The canvas is 716 × 358 px on the screen, printed 474.49 × 237.25 pt: 1 canvas px = 0.6627 pt.
#let k = 474.49pt / 716
#let chart-grey = rgb("#666666")
// chartjs-plugin-gradient, axis y, keyed by value: stops at 0, g, 2g, 3g, 4g
#let bar-colors = (rgb("#b0d2e8"), rgb("#73b3d8"), rgb("#3e8ec4"), rgb("#1563aa"), rgb("#08306b"))

// Chart.js niceNum for the linear y scale (maxTicksLimit 11 -> 10 spaces, precision 0 -> integer step)
#let nice-step(range) = {
  let e = calc.floor(calc.log(range, base: 10))
  let f = range / calc.pow(10.0, e)
  let n = if f <= 1 { 1 } else if f <= 2 { 2 } else if f <= 5 { 5 } else { 10 }
  calc.max(1, calc.ceil(n * calc.pow(10.0, e)))
}
// the colour of a value on the plugin's gradient (linear in sRGB between the stops)
#let value-color(v, g) = {
  let i = calc.min(calc.floor(v / g), 3)
  if v >= 4 * g { bar-colors.at(4) } else { color.mix((bar-colors.at(i), 1 - (v / g - i)), (bar-colors.at(i + 1), v / g - i), space: rgb) }
}
#let canvas-text(body, ..args) = text(size: 12 * k, fill: chart-grey, top-edge: "baseline", bottom-edge: "baseline", ..args, body)

// bars = ((label, count), ...)
#let year-chart(bars) = {
  let n = bars.len()
  let top-value = calc.max(..bars.map(b => b.at(1)))
  let step = nice-step(calc.max(top-value, 1) / 10)
  let y-max = calc.max(1, calc.ceil(top-value / step)) * step
  let ticks = range(0, y-max + 1, step: step)
  let g = calc.max(10, calc.min(150, calc.round(top-value / 4)))
  context {
    let w-px(body) = measure(canvas-text(body)).width / k
    // chart area left: the y axis (widest tick label + 3 px padding + 8 px tick; "300" -> 34 px as measured)
    let y-axis = calc.ceil(calc.max(..ticks.map(t => w-px(group-nl(t)))) + 13.5)
    let widest = calc.max(..bars.map(b => w-px(b.at(0))))
    // x labels: rotate when the widest does not fit its category (Chart.js: widest + 6 > category width), by
    // asin((label height + 6) / tick width), at most 50° (Chart.js calculateLabelRotation, its first term)
    let rot = if widest + 6 > (716 - y-axis) / n {
      calc.min(50deg, calc.asin(calc.min(1, (14.4 + 6) / ((716 - y-axis) / (n - 0.5)))))
    } else { 0deg }
    // a rotated first label hangs left of its category: the chart area moves right to make room for it
    let first-w = w-px(bars.at(0).at(0))
    let left = calc.max(y-axis, calc.ceil(calc.cos(rot) * first-w - (716 - y-axis) / n / 2 + 3))
    let cat = (716 - left) / n
    // skip labels (and their grid lines) when even rotated they overlap (Chart.js autoSkip, padding 3)
    let tick-size = if rot == 0deg { widest + 3 } else { calc.min((14.4 + 3) / calc.sin(rot), (widest + 3) / calc.cos(rot)) }
    let every = calc.max(1, calc.ceil(n / calc.max(1, calc.floor((716 - left) / tick-size))))
    let label-h = if rot == 0deg { 14.4 } else { widest * calc.sin(rot) + 14.4 * calc.cos(rot) }
    let bottom = 358 - 8 - 3 - label-h - 3.6
    let y(v) = bottom - (bottom - 34) * v / y-max // canvas y (down) of a value
    let bar-w = calc.min(0.8 * 0.9 * cat, 60)
    cetz.canvas(length: k, {
      import cetz.draw: *
      let P(x, yy) = (x, -yy) // canvas px, y down
      rect(P(0, 0), P(716, 358), stroke: none) // the canvas box
      let line-grey = rgb("#e5e5e5")
      // title
      content(P(358, 21), anchor: "south", canvas-text("Bouwjaren (wijk)", weight: 800))
      // y grid and tick marks, labels right-aligned 3 px left of the tick marks, centred on their line
      for t in ticks {
        let yy = calc.round(y(t)) + 0.5
        line(P(left - 8, yy), P(716, yy), stroke: 1 * k + line-grey)
        content(P(left - 11, yy + 4), anchor: "south-east", canvas-text(group-nl(t)))
      }
      // x grid at the category boundaries (offset: true), down to the tick marks
      for i in range(n) {
        if calc.rem(i, every) != 0 { continue }
        let xx = calc.round(left + i * cat - 0.5) + 0.5 // Chart.js _alignPixel
        line(P(xx, 34), P(xx, bottom + 8), stroke: 1 * k + line-grey)
      }
      // bars: a gradient from the value 0 colour to the colour of their own value
      for (i, (label, v)) in bars.enumerate() {
        let cx = left + (i + 0.5) * cat
        if v > 0 {
          let stops = ((bar-colors.at(0), 0%),)
          for j in range(1, 5) { if j * g < v { stops.push((bar-colors.at(j), j * g / v * 100%)) } }
          stops.push((value-color(v, g), 100%))
          rect(P(cx - bar-w / 2, y(v)), P(cx + bar-w / 2, y(0)), stroke: none,
            fill: gradient.linear(..stops, angle: 270deg, space: rgb))
        }
        if calc.rem(i, every) == 0 {
          if rot == 0deg {
            content(P(cx, 351), anchor: "south", canvas-text(label))
          } else {
            // Chart.js: right-aligned, the top of the 14.4 px line box on the anchor 3 px under the tick marks,
            // turned counter-clockwise around it (the baseline sits 11.2 px under the top, as for flat labels)
            content(P(cx, bottom + 8 + 3), anchor: "north-east", angle: rot,
              text(size: 12 * k, fill: chart-grey, top-edge: 11.2 * k, bottom-edge: -3.2 * k, label))
          }
        }
      }
      // the axis lines (a grid line twice), over the bars as in the canvas
      line(P(left + 0.5, 34), P(left + 0.5, bottom + 8), stroke: 1 * k + rgb("#cecece"))
      line(P(left - 8, calc.round(bottom) + 0.5), P(716, calc.round(bottom) + 0.5), stroke: 1 * k + rgb("#cecece"))
    })
  }
}

// MapLegend.vue: 9 items in 6 columns (px-2, gap-2), a 1.125 rem square 8 px left of the item, text 16 px in
#let legend(items) = pad(x: 8 * px, grid(columns: (1fr,) * 6, column-gutter: 8 * px, row-gutter: 8 * px,
  ..items.map(((label, fill)) => block(width: 100%, height: 18 * px, {
    place(top + left, dx: -8 * px, rect(width: 18 * px, height: 18 * px, fill: fill, stroke: none))
    pad(left: 16 * px + text-dx, label)
  }))))
// construction-year.layer.json: interpolate linear on construction_year; each square runs from the colour of its
// first year to the colour the next range starts with ("vanaf 2022" next to the chart's "vanaf 2020": kept)
#let year-legend = {
  let c = (rgb("#293575"), rgb("#1261a3"), rgb("#69a8de"), rgb("#99c1e9"), rgb("#b378b1"), rgb("#bd6495"),
    rgb("#ba2351"), rgb("#d11313"))
  let lin(a, b) = gradient.linear(a, b, space: rgb)
  (
    ("< 1960", c.at(0)), ("1960 t/m 1969", lin(c.at(0), c.at(1))), ("1970 t/m 1979", lin(c.at(1), c.at(2))),
    ("1980 t/m 1989", lin(c.at(2), c.at(3))), ("1990 t/m 1999", lin(c.at(3), c.at(4))),
    ("2000 t/m 2009", lin(c.at(4), c.at(5))), ("2010 t/m 2019", lin(c.at(5), c.at(6))),
    ("2020 t/m 2021", lin(c.at(6), c.at(7))), ("vanaf 2022", c.at(7)),
  )
}

// front = data-front.sql's object; map = map.ts --buildings output prefix; date = "YYYY-MM-DD" (for "vanaf")
#let bouwjaar(front, map, date) = {
  let year-now = int(date.slice(0, 4))
  let bars = front.statistics.at("construction_year_distribution", default: ()).map(r => {
    let y = int(r.year_from)
    let label = if y < 1100 { "Onbekend" } else if y + 9 >= year-now { "vanaf " + str(y) } else {
      str(y) + " t/m " + str(y + 9)
    }
    (label, int(r.count))
  })
  chapter("Bouwjaar", icon: "building", gap: 20 * px, {
    txt(text(fill: ink)[Het bouwjaar bepaalt vaak het funderingstype en daarmee het risicoprofiel: panden van vóór
      1960 staan in Nederland veelal op houten palen, die gevoelig zijn voor droogstand en bacteriële aantasting.
      Hieronder ziet u in welke periode uw pand is gebouwd en hoe dat zich verhoudt tot de panden in uw wijk.])
    v(28 * px)
    if bars.len() > 0 {
      block(width: 100%, height: 350 * px, year-chart(bars))
      v(28 * px)
    }
    map-box(json(map + ".labels.json"), map + ".svg", height: 311 * px)
    v(28 * px)
    legend(year-legend)
  })
}
