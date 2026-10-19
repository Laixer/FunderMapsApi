// Chapter "Hoe leest u dit rapport?" (ReportGuide.vue). Static text, no data.
#import "../lib.typ": *

// ol.list--legenda item: a 10 px dot with its bottom on the baseline, the bold letter in a 12 px box, the text;
// 10 px between the three (the dot is a box at the column edge, the letters are text: + text-dx)
#let legend-item(color, letter, label) = block(
  box(circle(radius: 5 * px, fill: color)) + h(10 * px + text-dx) + box(width: 12 * px, strong(letter))
    + h(10 * px) + label,
)
// ul list-disc item: 24 px indent, a 4 px disc in the text colour 9.71 pt before the text, 2.02 pt above the
// first baseline; the bold label takes the grey of the list
#let bullet-item(body) = pad(left: 24 * px, txt(block({
  place(top + left, dx: -9.71pt, dy: 13 * px - 2.02pt - 2 * px, circle(radius: 2 * px, fill: ink))
  text(fill: ink, body)
})))

#let leeswijzer() = chapter("Hoe leest u dit rapport?", icon: "info", gap: 20 * px, {
  txt(text(fill: ink)[Dit funderingsrisicorapport bundelt onderzoeksgegevens, modelresultaten en metingen voor
    uw pand en de directe omgeving. Hieronder staat kort uitgelegd hoe u de aanduidingen in de hoofdstukken
    hierna leest.])
  v(28 * px)
  txt(text(fill: grey-800, strong("Risicocategorieën")))
  v(12 * px)
  for (i, (color, letter, label)) in (
    (rgb("#2e7d32"), "A", "– Geen risico"),
    (rgb("#9e9d24"), "B", "– Laag risico"),
    (rgb("#f9a825"), "C", "– Verhoogd risico"),
    (rgb("#ef6c00"), "D", "– Hoog risico"),
    (rgb("#c62828"), "E", "– Aanzienlijk hoog risico"),
  ).enumerate() {
    if i > 0 { v(8 * px) }
    legend-item(color, letter, label)
  }
  v(12 * px)
  txt(text(fill: ink)[De categorieën lopen van A (laagste) tot E (hoogste). Een hogere categorie betekent een
    grotere kans op funderingsproblematiek – niet automatisch dat er nu al schade is.])
  v(28 * px)
  txt(text(fill: grey-800, strong("Betrouwbaarheid")))
  v(12 * px)
  txt(text(fill: ink)[Bij elke beoordeling staat hoe betrouwbaar de uitkomst is. Dat hangt af van welke gegevens
    beschikbaar zijn:])
  v(12 * px)
  bullet-item[#strong[Vastgesteld:] Er zijn specifieke onderzoeksgegevens beschikbaar voor dit pand zelf. De
    betrouwbaarheid is hoog.]
  v(8 * px)
  bullet-item[#strong[Afgeleid:] Er zijn geen directe gegevens voor dit pand, maar wel voor naastgelegen panden
    binnen dezelfde bouw- of funderingseenheid. Doorgaans goed onderbouwd, omdat vergelijkbare constructies en
    omstandigheden gelden.]
  v(8 * px)
  bullet-item[#strong[Indicatief:] Er zijn geen gegevens van dit pand of de omliggende panden. De uitkomst is een
    modelinschatting met een lagere betrouwbaarheid.]
})
