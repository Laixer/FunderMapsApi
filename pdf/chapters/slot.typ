// The two closing articles of PDF.vue: "Aanvullend onderzoek" and "Disclaimer" (header without icon,
// grey paragraphs 16 px apart, both breakable).
#import "../lib-back.typ": *

#let paras(..ps) = for (i, p) in ps.pos().enumerate() {
  if i > 0 { gap(16) }
  para(p)
}

#let aanvullend-onderzoek() = {
  back-header("Aanvullend onderzoek")
  let url = "https://www.kcaf.nl/quickscan-risicobeoordeling/"
  paras(
    "Wanneer het risico op funderingsproblematiek verhoogd is en de databetrouwbaarheid als vastgesteld of afgeleid wordt beschouwd, kan een QuickScan uitkomst bieden. Zeker wanneer u – of een expert – op basis van zichtbare signalen zoals scheurvorming of scheefstand vermoedt dat daadwerkelijk sprake is van funderingsschade.",
    "Een QuickScan is een snelle en relatief betaalbare methode om het funderingsrisico nader te beoordelen. Op basis van deze beoordeling kan worden vastgesteld of aanvullend funderingsonderzoek noodzakelijk is, of dat het risiconiveau juist naar beneden kan worden bijgesteld.",
    ("Meer informatie vindt u op de website van het Kennis Centrum Aanpak Funderingsproblematiek (KCAF): ", (t: url, url: url, fill: link-green)),
  )
}

#let disclaimer() = {
  back-header("Disclaimer")
  paras(
    "Dit funderingsrisicorapport is opgesteld op basis van beschikbare gegevens, metingen, modelanalyses en externe bronnen die op het moment van samenstelling beschikbaar waren. De gebruikte informatie is deels afkomstig van derden en/of berekend met behulp van algoritmen en risicomodellen. Waar mogelijk zijn deze gegevens aangevuld met locatiegerichte onderzoeksresultaten.",
    "De in dit rapport opgenomen funderingstypen en risico-indicaties zijn bedoeld als risicosignalering. Wanneer de betrouwbaarheid als indicatief is aangeduid, betreft het een globale modelinschatting op basis van generieke data. Deze gegevens geven geen garantie voor de daadwerkelijke staat van het pand en vormen geen vervanging van een technisch funderingsonderzoek op locatie.",
    "De betrouwbaarheid van het risicoprofiel verschilt per pand en is afhankelijk van de beschikbaarheid en kwaliteit van onderliggende data. Aanduidingen als vastgesteld, afgeleid of indicatief verwijzen naar deze mate van betrouwbaarheid.",
    "De informatie in dit rapport is uitsluitend bedoeld als hulpmiddel bij het verkrijgen van inzicht in mogelijke funderingsrisico's. Het rapport is niet bedoeld als bindend advies voor juridische of financiële besluitvorming, zoals aankoop, verkoop of hypothecaire financiering.",
    "Voor het vaststellen van de feitelijke staat van de fundering is een inspectie op locatie door een daartoe gespecialiseerd bureau noodzakelijk. Dit rapport vervangt een dergelijk onderzoek niet.",
    "De gegevens in dit rapport zijn momentopnamen. Funderingscondities en risico-inschattingen kunnen in de loop van de tijd wijzigen als gevolg van veranderende omgevingsfactoren of beschikbaarheid van nieuwe data.",
    "FunderMaps en haar partners spannen zich in om betrouwbare en actuele gegevens te leveren, maar kunnen niet instaan voor de juistheid, volledigheid of geschiktheid van de informatie voor het specifieke doel van de gebruiker. Gebruik van dit rapport is op eigen risico. FunderMaps aanvaardt geen aansprakelijkheid voor directe of indirecte schade als gevolg van interpretatie of toepassing van de gegevens in dit rapport.",
    "Bij twijfel over de inhoud of toepassing van dit rapport wordt geadviseerd contact op te nemen met een deskundig funderingsadviseur of een funderingsonderzoeksbureau.",
  )
}
