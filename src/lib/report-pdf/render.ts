import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NotFoundError } from "../errors.ts";
import { resolveToBuildingId } from "../../services/geocoder.ts";
import { loadReportData } from "./data.ts";
import { incidentDistricts, renderMap } from "./map.ts";

// The funderingsrisicorapport as a PDF, made with Typst: no browser, no report site, no Gotenberg.
//   1. the data: two read-only queries with the SQL of the API's five report calls (data.ts)
//   2. the maps: Locatie (zoom 16), Bouwjaar (zoom 17, the buildings by construction year) and Incidenten
//      (zoom 10, with the districts from the incident_district tiles), drawn from vector tiles (map.ts)
//   3. pdf/report.typ lays the report out on the old print's page frame and writes the PDF
// The template, its assets and the chart package live in pdf/; `bun run build` puts the pinned typst binary and the
// fonts (converted from the report's Greycliff web fonts) in pdf/.build (scripts/build-pdf.ts).

export const PDF_ROOT = fileURLToPath(new URL("../../../pdf/", import.meta.url));
const TYPST = process.env.PDF_TYPST_BIN ?? `${PDF_ROOT}.build/typst`;
const FONTS = `${PDF_ROOT}.build/fonts`;
const TIMEOUT_MS = 90_000;

// At most two reports at a time: one takes up to ~200 MB (typst) plus the three maps' tiles.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// "2026-10-19": the print date in Europe/Amsterdam (the report says "Gegenereerd op 19 oktober 2026")
export function amsterdamDate(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(at);
}

export interface RenderedReport {
  buildingId: string;
  pdf: Uint8Array;
  ms: { data: number; maps: number; typst: number };
}

export async function renderReportPdf(id: string): Promise<RenderedReport> {
  const buildingId = await resolveToBuildingId(id);
  const t0 = performance.now();
  const data = await loadReportData(buildingId);
  // The Vue report makes no PDF without building-info, analysis and the statistics neighbourhood
  const missing = data.front.missing ?? [];
  if (missing.length > 0) throw new NotFoundError(`No report data for ${buildingId}: ${missing.join(", ")}`);
  const t1 = performance.now();

  const bi = (data.front.building_info ?? {}) as Record<string, number | null>;
  const lon = bi.residence_lon ?? bi.building_lon ?? 4.897;
  const lat = bi.residence_lat ?? bi.building_lat ?? 52.377;
  const im = data.back.incident_map as
    | { center_lon: number | null; center_lat: number | null; bbox_3857: [number, number, number, number]; districts?: unknown }
    | null
    | undefined;
  const [location, year, incidents, districts] = await Promise.all([
    renderMap({ lon, lat, zoom: 16, width: 717, height: 319 }),
    renderMap({ lon, lat, zoom: 17, width: 717, height: 319, buildings: true }),
    renderMap({ lon: im?.center_lon ?? lon, lat: im?.center_lat ?? lat, zoom: 10, width: 717, height: 319, overview: true }),
    im ? incidentDistricts(im.bbox_3857) : [],
  ]);
  if (im) im.districts = districts;
  const t2 = performance.now();

  return await slot(async () => {
    // typst reads only below its root, so the request's files go in a folder of their own under pdf/.work
    const name = crypto.randomUUID();
    const dir = `${PDF_ROOT}.work/${name}`;
    await mkdir(dir, { recursive: true });
    try {
      await Promise.all([
        Bun.write(`${dir}/data.json`, JSON.stringify(data)),
        Bun.write(`${dir}/map-location.svg`, location.svg),
        Bun.write(`${dir}/map-location.labels.json`, JSON.stringify(location.labels)),
        Bun.write(`${dir}/map-year.svg`, year.svg),
        Bun.write(`${dir}/map-year.labels.json`, JSON.stringify(year.labels)),
        Bun.write(`${dir}/incidents.svg`, incidents.svg),
        Bun.write(`${dir}/incidents.labels.json`, JSON.stringify(incidents.labels)),
      ]);
      const proc = Bun.spawn([
        TYPST, "compile",
        "--root", PDF_ROOT,
        "--font-path", FONTS, "--ignore-system-fonts",
        "--package-cache-path", `${PDF_ROOT}packages`,
        "--input", `data=/.work/${name}/data.json`,
        "--input", `map=/.work/${name}/map`,
        "--input", `incident-map=/.work/${name}/incidents`,
        "--input", `date=${amsterdamDate()}`,
        `${PDF_ROOT}report.typ`, `${dir}/report.pdf`,
      ], { stdout: "ignore", stderr: "pipe", timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`typst exited with ${code}: ${stderr.slice(0, 2000)}`);
      const pdf = new Uint8Array(await Bun.file(`${dir}/report.pdf`).arrayBuffer());
      const t3 = performance.now();
      return { buildingId, pdf, ms: { data: Math.round(t1 - t0), maps: Math.round(t2 - t1), typst: Math.round(t3 - t2) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
