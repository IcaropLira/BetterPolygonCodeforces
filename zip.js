/* Leitor mínimo de .zip (stored + deflate) para o importador de pacotes do Polygon.
 * Usa DecompressionStream("deflate-raw"): Chrome 80+, Firefox 113+. Sem ZIP64 e sem criptografia. */
(() => {
  const MAX_ENTRY = 256 * 1024 * 1024; // limite por arquivo descompactado
  const decoder = new TextDecoder("utf-8");

  function open(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => view.getUint16(o, true);
    const u32 = (o) => view.getUint32(o, true);

    // fim do diretório central (EOCD)
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - 22 - 0xffff);
    for (let i = bytes.length - 22; i >= lowest; i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("O arquivo não é um .zip válido.");

    const total = u16(eocd + 10);
    const cdOffset = u32(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff) throw new Error("Zips ZIP64 (maiores que 4 GB) não são suportados.");

    const entries = new Map();
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
      if (p + 46 > bytes.length || u32(p) !== 0x02014b50) throw new Error("Diretório do zip corrompido.");
      const flags = u16(p + 8);
      const method = u16(p + 10);
      const csize = u32(p + 20);
      const usize = u32(p + 24);
      const nlen = u16(p + 28);
      const xlen = u16(p + 30);
      const clen = u16(p + 32);
      const lho = u32(p + 42);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, "/");
      p += 46 + nlen + xlen + clen;
      if (name.endsWith("/")) continue; // pasta
      if (flags & 1) throw new Error("Zip com senha não é suportado.");
      entries.set(name, { name, method, csize, usize, lho });
    }

    async function read(name) {
      const e = entries.get(name);
      if (!e) throw new Error("Arquivo ausente no zip: " + name);
      if (e.usize > MAX_ENTRY) throw new Error(`Arquivo grande demais (${name}).`);
      if (e.usize === 0) return new Uint8Array(0);
      const o = e.lho;
      if (o + 30 > bytes.length || u32(o) !== 0x04034b50) throw new Error("Cabeçalho local inválido: " + name);
      const start = o + 30 + u16(o + 26) + u16(o + 28);
      const raw = bytes.subarray(start, start + e.csize);
      let out;
      if (e.method === 0) out = raw.slice();
      else if (e.method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        out = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`Método de compressão ${e.method} não suportado (${name}).`);
      if (out.length !== e.usize) throw new Error("Tamanho inesperado após descompactar: " + name);
      return out;
    }

    return {
      names: () => Array.from(entries.keys()),
      has: (name) => entries.has(name),
      read,
      readText: async (name) => decoder.decode(await read(name))
    };
  }

  globalThis.PgxZip = { open };
})();
