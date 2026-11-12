/* Lê um pacote .zip gerado pelo Polygon (problem.xml + pastas) e devolve um "plano" de importação.
 * Só lê dados: não faz nenhuma chamada de rede. */
(() => {
  // helpers de DOM compatíveis com o DOMParser do navegador e com XMLs de teste
  const kids = (el, tag) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === tag) : []);
  const kid = (el, tag) => kids(el, tag)[0] || null;
  const text = (el, tag) => { const k = kid(el, tag); return k ? k.textContent.trim() : ""; };
  const attr = (el, name) => (el && el.hasAttribute(name) ? el.getAttribute(name) : null);
  const basename = (p) => p.split("/").pop();
  const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

  // tags de solução do problem.xml -> códigos da API
  const SOLUTION_TAGS = {
    "main": "MA", "main-correct": "MA",
    "accepted": "OK",
    "wrong-answer": "WA",
    "presentation-error": "PE",
    "time-limit-exceeded": "TL",
    "time-limit-exceeded-or-accepted": "TO",
    "time-limit-exceeded-or-memory-limit-exceeded": "TM",
    "memory-limit-exceeded": "ML",
    "rejected": "RJ", "fail": "RJ", "failed": "RJ",
    "do-not-run": "NR",
    "runtime-error": "RE"
  };

  const IMAGE_EXT = /\.(png|jpe?g|gif|svg|bmp|webp|eps)$/i;

  // "tests/%02d" + 3 -> "tests/03"
  function formatPattern(pattern, i) {
    return pattern.replace(/%(0?)(\d*)d/g, (m, zero, width) => {
      const s = String(i);
      return zero ? s.padStart(parseInt(width || "0", 10), "0") : s;
    });
  }

  async function parse(zip) {
    const names = zip.names();
    const xmlName = names
      .filter((n) => n === "problem.xml" || n.endsWith("/problem.xml"))
      .sort((a, b) => a.split("/").length - b.split("/").length)[0];
    if (!xmlName) throw new Error("problem.xml não encontrado: o zip não parece ser um pacote do Polygon.");
    const prefix = xmlName.slice(0, xmlName.length - "problem.xml".length);
    const P = (p) => prefix + String(p).replace(/\\/g, "/").replace(/^\.\//, "");

    const doc = new DOMParser().parseFromString(await zip.readText(xmlName), "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("problem.xml inválido (XML malformado).");
    const root = doc.documentElement;
    if (!root || root.localName !== "problem") throw new Error("problem.xml sem o elemento <problem>.");

    const warnings = [];
    const srcOf = (el) => {
      const s = kid(el, "source");
      const path = s && attr(s, "path");
      return path ? { path: P(path), name: basename(path), type: attr(s, "type") || "" } : null;
    };

    const plan = {
      shortName: attr(root, "short-name") || "",
      revision: attr(root, "revision") || "",
      title: "",
      inputFile: "",
      outputFile: "",
      treatPointsAsPercent: false,
      timeLimit: null,
      memoryLimitMb: null,
      interactive: false,
      testsets: [],
      statements: [],
      statementResources: [],
      resources: [],
      sources: [],
      checker: null,
      validators: [],
      interactor: null,
      solutions: [],
      tags: [],
      warnings
    };

    const nameEls = kids(kid(root, "names"), "name");
    const pick = nameEls.find((n) => attr(n, "language") === "english") || nameEls[0];
    plan.title = (pick && attr(pick, "value")) || plan.shortName;

    // ---- julgamento ----
    const judging = kid(root, "judging");
    plan.inputFile = attr(judging, "input-file") || "";
    plan.outputFile = attr(judging, "output-file") || "";
    plan.treatPointsAsPercent = attr(judging, "treat-points-from-checker-as-percent") === "true";

    for (const ts of kids(judging, "testset")) {
      const tsName = attr(ts, "name") || "tests";
      const inPattern = text(ts, "input-path-pattern");
      const set = { name: tsName, groups: [], tests: [] };

      const tl = num(text(ts, "time-limit"));
      const ml = num(text(ts, "memory-limit"));
      if (plan.timeLimit === null && tl !== null) plan.timeLimit = tl;
      if (plan.memoryLimitMb === null && ml !== null) plan.memoryLimitMb = Math.round(ml / 1048576);
      if (tsName === "tests") {
        if (tl !== null) plan.timeLimit = tl;
        if (ml !== null) plan.memoryLimitMb = Math.round(ml / 1048576);
      }

      for (const g of kids(kid(ts, "groups"), "group")) {
        set.groups.push({
          name: attr(g, "name") || "",
          pointsPolicy: (attr(g, "points-policy") || "").toUpperCase().replace(/-/g, "_"),
          feedbackPolicy: (attr(g, "feedback-policy") || "").toUpperCase().replace(/-/g, "_"),
          dependencies: kids(kid(g, "dependencies"), "dependency").map((d) => attr(d, "group")).filter((x) => x !== null)
        });
      }

      const testEls = kids(kid(ts, "tests"), "test");
      testEls.forEach((t, idx) => {
        const index = idx + 1;
        const path = P(formatPattern(inPattern, index));
        if (!zip.has(path)) { warnings.push(`Teste ${tsName}#${index}: arquivo ${path} não existe no zip (ignorado).`); return; }
        set.tests.push({
          index,
          path,
          sample: attr(t, "sample") === "true",
          points: num(attr(t, "points")),
          group: attr(t, "group"),
          description: attr(t, "description") || "",
          generated: attr(t, "method") === "generated"
        });
      });
      plan.testsets.push(set);
    }

    // ---- enunciados ----
    const seenRes = new Set();
    for (const n of names) {
      if (!n.startsWith(prefix)) continue;
      const rel = n.slice(prefix.length);
      const m = rel.match(/^statements\/([^/]+)\/(.+)$/);
      if (!m) continue;
      if (m[2] === "problem-properties.json") {
        let props;
        try { props = JSON.parse(await zip.readText(n)); }
        catch (e) { warnings.push(`Enunciado ${m[1]}: problem-properties.json ilegível (ignorado).`); continue; }
        const s = { lang: props.language || m[1] };
        for (const f of ["name", "legend", "input", "output", "scoring", "interaction", "notes", "tutorial"]) {
          if (typeof props[f] === "string" && props[f] !== "") s[f] = props[f];
        }
        plan.statements.push(s);
      } else if (!m[2].includes("/") && IMAGE_EXT.test(m[2]) && !seenRes.has(m[2])) {
        seenRes.add(m[2]);
        plan.statementResources.push({ name: m[2], path: n });
      }
    }

    // ---- arquivos ----
    const files = kid(root, "files");
    const seenSrc = new Set();
    const addSource = (s) => {
      if (s && !seenSrc.has(s.name)) { seenSrc.add(s.name); plan.sources.push(s); }
    };
    for (const f of kids(kid(files, "resources"), "file")) {
      const path = attr(f, "path");
      if (!path) continue;
      plan.resources.push({
        path: P(path),
        name: basename(path),
        forTypes: attr(f, "for-types"),
        stages: attr(f, "stages"),
        assets: attr(f, "assets")
      });
    }
    for (const ex of kids(kid(files, "executables"), "executable")) addSource(srcOf(ex));

    // ---- checker, validator, interactor, soluções ----
    const assets = kid(root, "assets");
    const ck = kid(assets, "checker");
    if (ck) {
      const ckName = attr(ck, "name") || "";
      if (ckName.startsWith("std::")) plan.checker = { standard: true, name: ckName };
      else {
        const s = srcOf(ck);
        if (s) { plan.checker = { standard: false, name: s.name, source: s }; addSource(s); }
        else warnings.push("Checker personalizado sem código-fonte no pacote (ignorado).");
      }
    }
    for (const v of kids(kid(assets, "validators"), "validator")) {
      const s = srcOf(v);
      if (s) { plan.validators.push(s); addSource(s); }
    }
    if (plan.validators.length > 1) warnings.push(`Há ${plan.validators.length} validators; só o primeiro será definido (a API não permite validators extras).`);
    const it = kid(assets, "interactor");
    if (it) {
      const s = srcOf(it);
      if (s) { plan.interactor = s; plan.interactive = true; addSource(s); }
    }
    for (const sol of kids(kid(assets, "solutions"), "solution")) {
      const s = srcOf(sol);
      if (!s) continue;
      const rawTag = attr(sol, "tag") || "accepted";
      let tag = SOLUTION_TAGS[rawTag];
      if (!tag) { warnings.push(`Solução ${s.name}: tag "${rawTag}" desconhecida; usando OK.`); tag = "OK"; }
      plan.solutions.push({ ...s, tag });
    }
    plan.solutions.sort((a, b) => (b.tag === "MA") - (a.tag === "MA"));

    plan.tags = kids(kid(root, "tags"), "tag").map((t) => attr(t, "value")).filter(Boolean);

    for (const f of [...plan.sources, ...plan.resources, ...plan.solutions, ...plan.statementResources]) {
      if (!zip.has(f.path)) warnings.push(`Arquivo ${f.path} está listado mas não existe no zip.`);
    }
    return plan;
  }

  function summarize(plan) {
    const tests = plan.testsets.reduce((n, s) => n + s.tests.length, 0);
    return [
      `Problema: ${plan.title || plan.shortName} (${plan.shortName})`,
      `${tests} teste(s), ${plan.solutions.length} solução(ões), ${plan.statements.length} enunciado(s)`,
      plan.checker ? `Checker: ${plan.checker.name}` : "Checker: (não definido)",
      plan.interactive ? "Interativo: sim" : ""
    ].filter(Boolean).join("\n");
  }

  globalThis.PgxPkg = { parse, summarize, formatPattern };
})();
