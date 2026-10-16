(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const DEFAULTS = {
    dark: true,
    modern: true,
    wide: true,
    filter: true,
    verdicts: true,
    shortcuts: true,
    tabindent: false,
    totop: true,
    copy: true,
    accent: "#4f7cff",
    density: "comfortable"
  };
  const BOOL_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "boolean");

  const root = document.documentElement;
  let cfg = { ...DEFAULTS };
  let domReady = false;
  let darkActive = false;

  try { Object.assign(cfg, JSON.parse(localStorage.getItem("pgx_cfg") || "{}")); } catch (e) {}

  /* =====================================================
   *  MOTOR DE MODO ESCURO (recolore as cores reais)
   * ===================================================== */
  const KEEP = 'input[type="submit"], input[type="button"], input[type="reset"], button, .pgx-keep';
  const originals = new WeakMap();

  function parseColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function toHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, s, l];
  }
  const hsla = (h, s, l, a) => `hsla(${h.toFixed(0)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${a})`;

  // fundos claros -> escuros (mantém matiz)
  function mapBg(c) {
    const [h, s, l] = toHsl(c);
    return hsla(h, Math.min(s * 0.8, 0.55), 0.07 + (1 - l) * 0.28, c.a);
  }
  // textos escuros -> claros
  function mapFg(c) {
    let [h, s, l] = toHsl(c);
    if (s > 0.5 && h >= 215 && h <= 265) h = 218; // azuis de link -> azul claro limpo
    return hsla(h, Math.min(s, 0.85), 0.93 - l * 0.45, c.a);
  }
  // bordas
  function mapBorder(c) {
    const [h, s, l] = toHsl(c);
    return hsla(h, s * 0.5, 0.14 + (1 - l) * 0.3, c.a);
  }

  function plan(el) {
    const cs = getComputedStyle(el);
    const ops = [];
    if (!el.matches(KEEP)) {
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0 && toHsl(bg)[2] > 0.5) ops.push(["background-color", mapBg(bg)]);
      const fg = parseColor(cs.color);
      if (fg && toHsl(fg)[2] < 0.6) ops.push(["color", mapFg(fg)]);
    }
    for (const side of ["top", "right", "bottom", "left"]) {
      const w = parseFloat(cs.getPropertyValue(`border-${side}-width`));
      const st = cs.getPropertyValue(`border-${side}-style`);
      if (!w || st === "none" || st === "hidden") continue;
      const c = parseColor(cs.getPropertyValue(`border-${side}-color`));
      if (c && c.a > 0 && toHsl(c)[2] > 0.35) ops.push([`border-${side}-color`, mapBorder(c)]);
    }
    return ops;
  }

  function processTree(node) {
    if (!darkActive || !node || node.nodeType !== 1) return;
    const list = [node, ...node.querySelectorAll("*")].filter((el) =>
      !(el instanceof SVGElement) &&
      !/^(SCRIPT|STYLE|LINK|META|HEAD|TITLE|NOSCRIPT|IMG|VIDEO|CANVAS|IFRAME|BR)$/.test(el.tagName) &&
      !el.hasAttribute("data-pgx-dr")
    );
    // fase 1: lê tudo; fase 2: escreve tudo (evita recalcular estilo a cada elemento)
    const plans = list.map((el) => [el, plan(el)]);
    for (const [el, ops] of plans) {
      el.setAttribute("data-pgx-dr", "1");
      if (!ops.length) continue;
      const o = originals.get(el) || {};
      for (const [prop, val] of ops) {
        if (!(prop in o)) o[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
        el.style.setProperty(prop, val, "important");
      }
      originals.set(el, o);
    }
  }

  function restoreAll() {
    document.querySelectorAll("[data-pgx-dr]").forEach((el) => {
      const o = originals.get(el);
      if (o) {
        for (const prop in o) {
          if (o[prop][0]) el.style.setProperty(prop, o[prop][0], o[prop][1]);
          else el.style.removeProperty(prop);
        }
        originals.delete(el);
      }
      el.removeAttribute("data-pgx-dr");
    });
  }

  /* Hover: recolore fundos/textos claros que só aparecem em :hover */
  const hovered = new Map();
  function clearHover(keep) {
    for (const [el, saved] of hovered) {
      if (keep && keep.has(el)) continue;
      for (const prop in saved) {
        if (saved[prop][0]) el.style.setProperty(prop, saved[prop][0], saved[prop][1]);
        else el.style.removeProperty(prop);
      }
      hovered.delete(el);
    }
  }
  document.addEventListener("mouseover", (e) => {
    if (!darkActive || !(e.target instanceof Element)) return;
    const chain = [];
    for (let el = e.target; el && el !== document.documentElement; el = el.parentElement) {
      chain.push(el);
      if (el.tagName === "TR") chain.push(...el.cells);
    }
    clearHover(new Set(chain));
    const reads = chain
      .filter((el) => !hovered.has(el) && !(el instanceof SVGElement) && !el.matches(KEEP))
      .map((el) => { const cs = getComputedStyle(el); return [el, parseColor(cs.backgroundColor), parseColor(cs.color)]; });
    for (const [el, bg, fg] of reads) {
      const saved = {};
      if (bg && bg.a > 0 && toHsl(bg)[2] > 0.5) {
        saved["background-color"] = [el.style.getPropertyValue("background-color"), el.style.getPropertyPriority("background-color")];
        el.style.setProperty("background-color", mapBg(bg), "important");
      }
      if (fg && toHsl(fg)[2] < 0.6) {
        saved.color = [el.style.getPropertyValue("color"), el.style.getPropertyPriority("color")];
        el.style.setProperty("color", mapFg(fg), "important");
      }
      if (Object.keys(saved).length) hovered.set(el, saved);
    }
  }, true);
  document.documentElement.addEventListener("mouseleave", () => clearHover());

  function syncDark() {
    if (cfg.dark && !darkActive) {
      darkActive = true;
      if (domReady) { processTree(document.body); root.classList.add("pgx-ready"); }
    } else if (!cfg.dark && darkActive) {
      darkActive = false;
      restoreAll();
    }
  }

  /* =====================================================
   *  CONFIGURAÇÕES
   * ===================================================== */
  function applyClasses() {
    for (const k of BOOL_KEYS) root.classList.toggle("pgx-on-" + k, !!cfg[k]);
    root.classList.toggle("pgx-compact", cfg.density === "compact");
    root.style.setProperty("--pgx-accent", cfg.accent);
    try { localStorage.setItem("pgx_cfg", JSON.stringify(cfg)); } catch (e) {}
    syncDark();
  }
  applyClasses();

  api.storage.local.get(DEFAULTS).then((saved) => { cfg = { ...DEFAULTS, ...saved }; applyClasses(); });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k in changes) cfg[k] = changes[k].newValue;
    applyClasses();
  });

  /* =====================================================
   *  RECURSOS
   * ===================================================== */
  const VERDICTS = [
    ["pgx-ok",   /^(OK|Accepted|Passed|Success|Correct)\b/i],
    ["pgx-bad",  /^(Wrong answer|Runtime error|Failed|Fail|Presentation error|Compilation error|Invalid)/i],
    ["pgx-warn", /^(Time limit exceeded|Memory limit exceeded|Idleness limit exceeded|Skipped|Judgement failed)/i],
    ["pgx-run",  /^(Running|Waiting|In queue|Testing)/i]
  ];
  function colorVerdicts() {
    document.querySelectorAll("td, span, b").forEach((el) => {
      if (el.children.length || el.dataset.pgxV) return;
      const t = el.textContent.trim();
      if (!t || t.length > 60) return;
      for (const [cls, re] of VERDICTS) {
        if (re.test(t)) { el.classList.add("pgx-verdict", cls); break; }
      }
      el.dataset.pgxV = "1";
    });
  }

  // marca tabelas de dados (cabeçalho com <th> direto na 1ª linha, sem tabelas aninhadas)
  function markTables() {
    document.querySelectorAll("table").forEach((t) => {
      if (t.dataset.pgxT) return;
      t.dataset.pgxT = "1";
      if (t.querySelector("table")) return;
      const first = t.rows[0];
      if (first && Array.from(first.cells).some((c) => c.tagName === "TH")) t.classList.add("pgx-data");
    });
  }

  function markDates() {
    document.querySelectorAll("table.pgx-data td").forEach((td) => {
      if (td.dataset.pgxD) return;
      td.dataset.pgxD = "1";
      if (/^\s*\d{4}-\d{2}-\d{2}/.test(td.textContent)) td.classList.add("pgx-nowrap");
    });
  }

  function addFilters() {
    document.querySelectorAll("table.pgx-data").forEach((table) => {
      if (table.dataset.pgxFilter) return;
      const dataRows = Array.from(table.rows).filter((r) => !r.querySelector("th"));
      if (dataRows.length < 8) return;
      table.dataset.pgxFilter = "1";
      const input = document.createElement("input");
      input.type = "search";
      input.className = "pgx-filter";
      input.placeholder = "Filtrar linhas…  (atalho: /)";
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        dataRows.forEach((r) => { r.style.display = !q || r.textContent.toLowerCase().includes(q) ? "" : "none"; });
      });
      table.parentNode.insertBefore(input, table);
    });
  }

  // cards: caixas com borda arredondada ganham sombra suave
  function markCards() {
    document.querySelectorAll("div, form, fieldset").forEach((el) => {
      if (el.dataset.pgxC) return;
      el.dataset.pgxC = "1";
      const cs = getComputedStyle(el);
      if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) >= 6) {
        el.classList.add("pgx-card");
        // barra de menu: caixa baixa com vários links
        const links = el.querySelectorAll("a");
        if (links.length >= 3 && el.offsetHeight < 80) {
          el.classList.add("pgx-nav");
          links.forEach((a) => {
            if (parseInt(getComputedStyle(a).fontWeight, 10) >= 600) a.classList.add("pgx-nav-current");
          });
        }
      }
    });
  }

  // botão copiar em blocos <pre>
  function addCopyButtons() {
    document.querySelectorAll("pre").forEach((pre) => {
      if (pre.dataset.pgxCopy) return;
      pre.dataset.pgxCopy = "1";
      if (pre.textContent.trim().length < 8) return;
      pre.classList.add("pgx-has-copy");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pgx-copy";
      btn.textContent = "Copiar";
      btn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        const text = Array.from(pre.childNodes).filter((n) => n !== btn).map((n) => n.textContent).join("");
        try { await navigator.clipboard.writeText(text); btn.textContent = "Copiado!"; }
        catch (err) { btn.textContent = "Erro"; }
        setTimeout(() => (btn.textContent = "Copiar"), 1200);
      });
      pre.appendChild(btn);
    });
  }

  function addToTop() {
    if (document.getElementById("pgx-totop")) return;
    const b = document.createElement("button");
    b.id = "pgx-totop";
    b.type = "button";
    b.title = "Voltar ao topo";
    b.textContent = "↑";
    b.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    document.body.appendChild(b);
    window.addEventListener("scroll", () => b.classList.toggle("pgx-show", window.scrollY > 400), { passive: true });
  }

  /* ---------- Atalhos ---------- */
  document.addEventListener("keydown", (e) => {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

    if (cfg.tabindent && el && el.tagName === "TEXTAREA" && e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      el.setRangeText("    ", el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (!cfg.shortcuts) return;

    const save = (e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key.toLowerCase() === "s");
    if (save && el && el.closest && el.closest("form")) {
      e.preventDefault();
      const form = el.closest("form");
      const btn = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
      if (btn) btn.click();
      else if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return;
    }
    if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const f = document.querySelector(".pgx-filter");
      if (f) { e.preventDefault(); f.focus(); f.select(); }
    }
  });

  /* ---------- Inicialização ---------- */
  function run() {
    markTables();
    markDates();
    colorVerdicts();
    addFilters();
    markCards();
    addCopyButtons();
  }

  function start() {
    if (domReady) return;
    domReady = true;
    run();
    addToTop();
    if (darkActive) processTree(document.body);
    root.classList.add("pgx-ready");

    let timer;
    let pending = new Set();
    new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n.nodeType === 1 && pending.add(n));
      clearTimeout(timer);
      timer = setTimeout(() => {
        run();
        const nodes = Array.from(pending); pending = new Set();
        nodes.forEach((n) => document.contains(n) && processTree(n));
      }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function whenReady() {
    // espera as folhas de estilo da página para ler as cores finais
    if (document.readyState === "complete") start();
    else {
      window.addEventListener("load", start, { once: true });
      setTimeout(start, 1500); // fallback para não deixar a página escondida
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", whenReady);
  else whenReady();
})();
