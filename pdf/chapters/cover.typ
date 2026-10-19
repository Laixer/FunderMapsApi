// The cover band on page 1 (PDF.vue <header class="header--print">). No data.
#import "../lib.typ": *

// The cover band (PDF.vue header--print): blue-900, the contour artwork left, logo and title centred. On the
// chapter column of px-page it reaches 10.85 pt into the margin on both sides (the full content box).
#let cover-band() = pad(x: -16 * px, block(width: 100%, height: 143 * px, radius: 6 * px, clip: true,
  fill: blue-900, {
    place(top + left, image("/assets/front/header-artifact.print.png", width: 535 * px, height: 143 * px))
    place(top + center, dy: 21.01pt, image("/assets/front/fundermaps-inverted.svg", height: 32 * px))
    // h1 37 px ExtraBold, white; baseline 69.80 pt below the band top (measured 119.30). CSS tracking is
    // -0.001 em; Chromium's whole-px glyph advances make the word 1.79 pt wider (272.36 pt, x 162.20 – 434.56):
    // matched with +1.79 pt / 23 letters of tracking
    place(top + center, dy: 69.80pt - 32 * px, text(size: 37 * px, weight: 800, tracking: -0.001em + 1.79pt / 23,
      fill: white, top-edge: 32 * px, bottom-edge: -10 * px, "Funderingsrisicorapport"))
  }))
