import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

// A print map of a pand's surroundings, without a browser: the OpenFreeMap vector tiles the FunderMaps basemap
// uses (tiles.fundermaps.com/style/fundermaps-basemap), drawn as SVG shapes in that style's colours. Street names
// come out as a list of labels (position, angle, text) that the Typst template sets in the report's own font.
// Width and height are the map's CSS pixels (MapLibre's 512-px tiles); the template scales the whole to its box.
//   buildings: also draw the FunderMaps `buildings` source (Martin, public) on top, flat, each footprint in its
//              construction-year colour (pdf/assets/front/construction-year.layer.json): the Bouwjaar map.
//   overview:  leave out buildings, footpaths and minor streets, as a zoom-10 map shows them: the Incidenten map.

export interface MapOptions {
  lon: number;
  lat: number;
  zoom: number;
  width: number;
  height: number;
  buildings?: boolean;
  overview?: boolean;
}
export interface MapLabels {
  width: number;
  height: number;
  size: number;
  color: string;
  labels: { x: number; y: number; angle: number; text: string }[];
}

const BASEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
const BUILDINGS_TILEJSON = "https://tiles.fundermaps.com/buildings";
const YEAR_LAYER = new URL("../../../pdf/assets/front/construction-year.layer.json", import.meta.url);

// ---- colours and widths from the basemap style (layer id in the comment)
const C = {
  background: "hsl(40, 48%, 92%)", // background
  residential: "hsl(40, 47%, 90%)", // landuse_residential
  park: "hsl(78, 49%, 71%)", // park
  wood: "hsla(83, 45%, 70%, 0.8)", // landcover_wood
  water: "hsl(205, 76%, 70%)", // water, waterway
  building: "hsl(40, 43%, 81%)", // building
  buildingLine: "hsl(40, 42%, 77%)", // building fill-outline-color
  casing: "hsl(40, 46%, 86%)", // highway_major_casing
  road: "hsl(40, 47%, 96%)", // highway_minor, highway_major_inner, highway_path
  rail: "hsl(40, 42%, 77%)", // railway
};
const LABEL_SIZE = 13; // highway-name-* text-size at zoom >= 14
const LABEL_COLOR = "hsl(40, 47%, 41%)";

// ---- fetching: TileJSON for an hour, tiles in a small LRU (panden near each other share tiles)
const tileJson = new Map<string, { at: number; json: { tiles: string[]; maxzoom?: number } }>();
async function getTileJson(url: string) {
  const hit = tileJson.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.json;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`map: ${url} answered ${r.status}`);
  const json = (await r.json()) as { tiles: string[]; maxzoom?: number };
  tileJson.set(url, { at: Date.now(), json });
  return json;
}
const tiles = new Map<string, Uint8Array>();
const TILE_CACHE = 256;
async function getTile(url: string): Promise<Uint8Array | null> {
  const hit = tiles.get(url);
  if (hit) {
    tiles.delete(url);
    tiles.set(url, hit);
    return hit;
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw new Error(`map: tile ${url} answered ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  tiles.set(url, buf);
  if (tiles.size > TILE_CACHE) tiles.delete(tiles.keys().next().value!);
  return buf;
}

type Pt = { x: number; y: number };
type Feat = { layer: string; cls: string; type: number; rings: Pt[][]; name?: string };

export async function renderMap(o: MapOptions): Promise<{ svg: string; labels: MapLabels }> {
  const { lon, lat, zoom, width: W, height: H } = o;
  // The tiles MapLibre itself would read for this view: the view's whole zoom, at most 14 (the planet tiles stop
  // there and are over-zoomed above it).
  const dataZoom = Math.max(0, Math.min(14, Math.floor(zoom)));
  // ["interpolate", ["exponential", base], ["zoom"], z0, v0, z1, v1] at the map's zoom
  const interp = (base: number, z0: number, v0: number, z1: number, v1: number) => {
    const t = Math.min(1, Math.max(0, base === 1
      ? (zoom - z0) / (z1 - z0)
      : (Math.pow(base, zoom - z0) - 1) / (Math.pow(base, z1 - z0) - 1)));
    return v0 + (v1 - v0) * t;
  };
  const WIDTH = {
    path: interp(1.2, 13, 1, 20, 10),
    minor: interp(1.55, 13, 1.8, 20, 20),
    majorCasing: interp(1.3, 10, 3, 20, 23),
    majorInner: interp(1.3, 10, 2, 20, 20),
    rail: interp(1.3, 16, 3, 20, 7),
    waterway: 1.5,
  };

  // projection: Web Mercator with 512-px tiles, as MapLibre
  const world = 512 * Math.pow(2, zoom);
  const wx = (lo: number) => ((lo + 180) / 360) * world;
  const wy = (la: number) => {
    const s = Math.sin((la * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  };
  const left = wx(lon) - W / 2, top = wy(lat) - H / 2;
  const pad = 64; // tiles a little past the view, so lines that enter it are whole
  const tileRange = (z: number) => {
    const px = 512 * Math.pow(2, zoom - z);
    const xs: [number, number] = [Math.floor((left - pad) / px), Math.floor((left + W + pad) / px)];
    const ys: [number, number] = [Math.floor((top - pad) / px), Math.floor((top + H + pad) / px)];
    const list: [number, number][] = [];
    for (let y = ys[0]; y <= ys[1]; y++) for (let x = xs[0]; x <= xs[1]; x++) list.push([x, y]);
    return { px, list };
  };
  const project = (tx: number, ty: number, px: number, ext: number) => (p: { x: number; y: number }) =>
    ({ x: (tx + p.x / ext) * px - left, y: (ty + p.y / ext) * px - top });

  // ---- basemap features
  const base = await getTileJson(BASEMAP_TILEJSON);
  const want = new Set(["landuse", "park", "landcover", "water", "waterway", "building", "transportation", "transportation_name"]);
  const feats: Feat[] = [];
  const { px: tilePx, list } = tileRange(dataZoom);
  await Promise.all(list.map(async ([tx, ty]) => {
    const url = base.tiles[0]!.replace("{z}", String(dataZoom)).replace("{x}", String(tx)).replace("{y}", String(ty));
    const buf = await getTile(url);
    if (!buf) return;
    const vt = new VectorTile(new PbfReader(buf));
    for (const name of Object.keys(vt.layers)) {
      if (!want.has(name)) continue;
      const layer = vt.layers[name]!;
      for (let k = 0; k < layer.length; k++) {
        const f = layer.feature(k);
        const at = project(tx, ty, tilePx, f.extent);
        const p = f.properties as Record<string, string | number | boolean>;
        feats.push({
          layer: name,
          cls: String(p.class ?? ""),
          type: f.type,
          rings: f.loadGeometry().map((ring) => ring.map(at)),
          name: (p["name:nl"] ?? p.name) as string | undefined,
        });
      }
    }
  }));

  // ---- FunderMaps buildings in their construction-year colour (the layer's own colour ramp)
  const buildings: { rings: Pt[][]; color: string }[] = [];
  if (o.buildings) {
    const layer = JSON.parse(await Bun.file(YEAR_LAYER).text());
    const expr = layer.paint["fill-extrusion-color"]; // ["interpolate", ["linear"], ["get", "construction_year"], y, c, ...]
    const stops: [number, string][] = [];
    for (let i = 3; i < expr.length; i += 2) stops.push([expr[i], expr[i + 1]]);
    const rgbOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const colorOf = (year: number): string => {
      if (year <= stops[0]![0]) return stops[0]![1];
      for (let i = 1; i < stops.length; i++) {
        const [y1, c1] = stops[i]!;
        if (year <= y1) {
          const [y0, c0] = stops[i - 1]!;
          const t = (year - y0) / (y1 - y0), a = rgbOf(c0), b = rgbOf(c1);
          return "#" + a.map((v, j) => Math.round(v + (b[j]! - v) * t).toString(16).padStart(2, "0")).join("");
        }
      }
      return stops[stops.length - 1]![1];
    };
    const tj = await getTileJson(BUILDINGS_TILEJSON);
    const bz = Math.min(tj.maxzoom ?? 16, Math.floor(zoom)); // over-zoomed above the source's maxzoom, as MapLibre
    const { px: bPx, list: bList } = tileRange(bz);
    await Promise.all(bList.map(async ([tx, ty]) => {
      const url = tj.tiles[0]!.replace("{z}", String(bz)).replace("{x}", String(tx)).replace("{y}", String(ty));
      const buf = await getTile(url);
      if (!buf || !buf.length) return;
      const l = new VectorTile(new PbfReader(buf)).layers[layer["source-layer"]];
      if (!l) return;
      for (let k = 0; k < l.length; k++) {
        const f = l.feature(k);
        const year = (f.properties as Record<string, unknown>).construction_year;
        if (f.type !== 3 || typeof year !== "number") continue;
        const at = project(tx, ty, bPx, f.extent);
        buildings.push({ rings: f.loadGeometry().map((ring) => ring.map(at)), color: colorOf(year) });
      }
    }));
  }

  // ---- SVG, in the style's layer order
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const d = (rings: Pt[][], close: boolean) =>
    rings.map((r) => "M" + r.map((p) => `${r1(p.x)} ${r1(p.y)}`).join("L") + (close ? "Z" : "")).join("");
  const polys = (pred: (f: Feat) => boolean) => feats.filter((f) => f.type === 3 && pred(f)).map((f) => d(f.rings, true)).join("");
  const lines = (pred: (f: Feat) => boolean) => feats.filter((f) => f.type === 2 && pred(f)).map((f) => d(f.rings, false)).join("");
  // nonzero, not evenodd: a feature in the buffer of two tiles comes twice, and evenodd would cut the overlap out
  const fill = (dd: string, color: string, extra = "") => (dd ? `<path d="${dd}" fill="${color}" fill-rule="nonzero"${extra}/>` : "");
  const stroke = (dd: string, color: string, w: number) =>
    dd ? `<path d="${dd}" fill="none" stroke="${color}" stroke-width="${r1(w)}" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  const minor = (f: Feat) => f.layer === "transportation" && ["minor", "service", "track"].includes(f.cls);
  const major = (f: Feat) => f.layer === "transportation" && ["primary", "secondary", "tertiary", "trunk", "motorway"].includes(f.cls);
  const detail = !o.overview;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="${C.background}"/>`,
    fill(polys((f) => f.layer === "landuse" && f.cls === "residential"), C.residential),
    fill(polys((f) => f.layer === "park"), C.park),
    fill(polys((f) => f.layer === "landcover" && f.cls === "wood"), C.wood),
    fill(polys((f) => f.layer === "water"), C.water),
    stroke(lines((f) => f.layer === "waterway"), C.water, WIDTH.waterway),
    detail ? fill(polys((f) => f.layer === "building"), C.building, ` stroke="${C.buildingLine}" stroke-width="0.6"`) : "",
    detail ? stroke(lines((f) => f.layer === "transportation" && f.cls === "path"), C.road, WIDTH.path) : "",
    stroke(lines(major), C.casing, WIDTH.majorCasing),
    detail ? stroke(lines(minor), C.road, WIDTH.minor) : "",
    stroke(lines(major), C.road, WIDTH.majorInner),
    stroke(lines((f) => f.layer === "transportation" && f.cls === "rail"), C.rail, WIDTH.rail),
    // the construction-year layer goes on top of every style layer (ConstructionYearChapter.vue)
    ...[...Map.groupBy(buildings, (b) => b.color)].map(([color, bs]) => fill(bs.map((b) => d(b.rings, true)).join(""), color)),
    `</svg>`,
  ].join("\n");

  // ---- street names: one per street, on its longest straight piece inside the view, no overlaps
  type Label = { x: number; y: number; angle: number; text: string; len: number };
  const best = new Map<string, Label>();
  for (const f of feats) {
    if (f.layer !== "transportation_name" || !f.name || f.type !== 2) continue;
    if (o.overview && !major(f)) continue;
    for (const ring of f.rings) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!, b = ring[i]!;
        const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2, len = Math.hypot(b.x - a.x, b.y - a.y);
        const textLen = f.name.length * LABEL_SIZE * 0.55;
        if (len < textLen * 0.8 || x < textLen / 2 || x > W - textLen / 2 || y < 10 || y > H - 10) continue;
        let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        const prev = best.get(f.name);
        if (!prev || len > prev.len) best.set(f.name, { x, y, angle, text: f.name, len });
      }
    }
  }
  const placed: Label[] = [];
  const near = (a: Label, b: Label) => Math.hypot(a.x - b.x, a.y - b.y) < (a.text.length + b.text.length) * LABEL_SIZE * 0.3;
  for (const l of [...best.values()].sort((a, b) => b.len - a.len)) if (!placed.some((p) => near(p, l))) placed.push(l);

  return {
    svg,
    labels: {
      width: W,
      height: H,
      size: LABEL_SIZE,
      color: LABEL_COLOR,
      labels: placed.map((l) => ({ x: r1(l.x), y: r1(l.y), angle: r1(l.angle), text: l.text })),
    },
  };
}
