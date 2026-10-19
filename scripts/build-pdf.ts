// `bun run build`: what the Typst PDF (src/lib/report-pdf/) needs next to the code, in pdf/.build:
//   typst  the official Typst release, pinned and checked against its sha256 (a static Linux binary)
//   fonts  the report's Greycliff CF web fonts (pdf/fonts/*.woff2) as OpenType: Typst reads no woff2
// Runs in the App Platform build (the bun buildpack runs `bun run build` after `bun install`). Each step is
// skipped when its output is already there. On any failure the build fails, and the running deployment stays.
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { decompress } from "wawoff2";
import { XzReadableStream } from "xz-decompress";

const TYPST_VERSION = "0.15.1";
const TYPST_ASSET = "typst-x86_64-unknown-linux-musl";
const TYPST_SHA256 = "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c";

const root = new URL("../pdf/", import.meta.url).pathname;
const out = `${root}.build`;
await mkdir(`${out}/fonts`, { recursive: true });

async function typst() {
  const bin = `${out}/typst`;
  if (await Bun.file(bin).exists()) {
    const v = Bun.spawnSync([bin, "--version"]).stdout.toString();
    if (v.includes(TYPST_VERSION)) return console.log(`typst ${TYPST_VERSION}: present`);
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`no pinned typst for ${process.platform}/${process.arch}: set PDF_TYPST_BIN to a typst ${TYPST_VERSION}`);
  }
  const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${TYPST_ASSET}.tar.xz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`typst download: ${res.status} for ${url}`);
  const tarball = new Uint8Array(await res.arrayBuffer());
  const sha = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  if (sha !== TYPST_SHA256) throw new Error(`typst download: sha256 ${sha}, expected ${TYPST_SHA256}`);
  const tmp = `${out}/download`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await Bun.write(`${tmp}/typst.tar.xz`, tarball);
  // the system tar when it reads xz; otherwise xz in WebAssembly and the one file read out of the tar here
  let unpacked = false;
  try {
    unpacked = Bun.spawnSync(["tar", "-xJf", `${tmp}/typst.tar.xz`, "-C", tmp]).exitCode === 0;
  } catch {
    // no tar at all
  }
  if (unpacked) {
    await Bun.write(bin, Bun.file(`${tmp}/${TYPST_ASSET}/typst`));
  } else {
    const plain = new Uint8Array(await new Response(new XzReadableStream(new Blob([tarball]).stream())).arrayBuffer());
    await Bun.write(bin, fileInTar(plain, `${TYPST_ASSET}/typst`));
  }
  await chmod(bin, 0o755);
  await rm(tmp, { recursive: true, force: true });
  console.log(`typst ${TYPST_VERSION}: ${Bun.spawnSync([bin, "--version"]).stdout.toString().trim()}`);
}

// One regular file out of a (ustar) tar: 512-byte headers, the size in octal, the data padded to 512 bytes.
function fileInTar(tar: Uint8Array, wanted: string): Uint8Array {
  const text = (from: number, len: number) => new TextDecoder().decode(tar.subarray(from, from + len)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const prefix = text(at + 345, 155);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    if ((prefix ? `${prefix}/${name}` : name) === wanted) return tar.slice(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`typst unpack: ${wanted} is not in the release`);
}

async function fonts() {
  for (const name of await readdir(`${root}fonts`)) {
    if (!name.endsWith(".woff2")) continue;
    const target = `${out}/fonts/${name.replace(/\.woff2$/, ".otf")}`;
    if (await Bun.file(target).exists()) continue;
    await Bun.write(target, await decompress(await Bun.file(`${root}fonts/${name}`).bytes()));
    console.log(`font: ${name} -> ${target.slice(root.length)}`);
  }
}

await typst();
await fonts();
