/* Cliente mínimo da API do Polygon (https://polygon.codeforces.com/api/<método>).
 * Assinatura: apiSig = rand + sha512hex(rand + "/" + método + "?" + params ordenados "k=v&..." + "#" + secret).
 * Os arquivos (bytes) também entram na assinatura. O corpo é multipart montado à mão para os bytes
 * assinados serem exatamente os enviados (FormData converteria \n em \r\n). */
(() => {
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

  function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function cmp(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }

  // entries: [[nome:string, valor:Uint8Array], ...] (sem apiSig)
  async function signature(method, entries, secret, rand = randomHex(3)) {
    const sorted = entries
      .map(([k, v]) => [enc.encode(k), v])
      .sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
    const parts = [enc.encode(rand + "/" + method + "?")];
    sorted.forEach(([k, v], i) => {
      if (i) parts.push(enc.encode("&"));
      parts.push(k, enc.encode("="), v);
    });
    parts.push(enc.encode("#" + secret));
    return rand + hex(await crypto.subtle.digest("SHA-512", concat(parts)));
  }

  function multipart(entries) {
    const boundary = "----pgx" + randomHex(12);
    const parts = [];
    for (const [k, v] of entries) {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/["\r\n]/g, "")}"\r\n\r\n`), v, enc.encode("\r\n"));
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    return { boundary, body: concat(parts) };
  }

  class PolygonError extends Error {}

  function createClient({ apiKey, apiSecret, baseUrl = "/api/", fetchImpl = (...a) => fetch(...a), retries = 2 }) {
    async function attempt(method, params) {
      const entries = [];
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        entries.push([k, v instanceof Uint8Array ? v : enc.encode(String(v))]);
      }
      entries.push(["apiKey", enc.encode(apiKey)], ["time", enc.encode(String(Math.floor(Date.now() / 1000)))]);
      entries.push(["apiSig", enc.encode(await signature(method, entries, apiSecret))]);
      const { boundary, body } = multipart(entries);
      const res = await fetchImpl(baseUrl + method, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
        body,
        credentials: "omit"
      });
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); } catch (e) { throw new PolygonError(`Resposta inválida do Polygon (HTTP ${res.status}).`); }
      if (json.status !== "OK") throw new PolygonError(json.comment || "Falha sem mensagem.");
      return json.result;
    }

    return {
      async call(method, params = {}) {
        for (let i = 0; ; i++) {
          try { return await attempt(method, params); }
          catch (e) {
            // só repete falhas de rede (fetch lança TypeError); erro da API não adianta repetir
            if (e instanceof PolygonError || i >= retries) throw e;
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
          }
        }
      }
    };
  }

  globalThis.PgxApi = { createClient, signature, PolygonError };
})();
