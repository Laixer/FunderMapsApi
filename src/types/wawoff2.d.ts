// wawoff2 (Google's woff2 in WebAssembly) ships no types; scripts/build-pdf.ts uses its decompress.
declare module "wawoff2" {
  export function decompress(input: Uint8Array): Promise<Uint8Array>;
  export function compress(input: Uint8Array): Promise<Uint8Array>;
}
