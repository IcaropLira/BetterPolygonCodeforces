/* Importa um pacote .zip gerado pelo Polygon como um NOVO problema, via API oficial.
 * Não vincula a contests (isso fica para depois). Não faz commit: o problema fica como working copy. */
(() => {
  const enc = new TextEncoder();

  // Executa o plano; report(texto, feito, total) atualiza a interface. Retorna { problemId, name, failures }.
  async function runImport({ zip, plan, client, report, nameOverride }) {
    const failures = [];
    const steps = [];
    let problemId = null;
    let done = 0;

    const step = (label, fn, { fatal = false } = {}) => steps.push({ label, fn, fatal });

    const P = () => ({ problemId });

    // ---- 1. criar ----
    step("Criando problema", async () => {
      const base = nameOverride || plan.shortName || "imported-problem";
      let lastErr;
      for (let i = 0; i < 5; i++) {
        const name = i === 0 ? base : `${base}-${i + 1}`;
        try {
          const r = await client.call("problem.create", { name });
          problemId = r.id;
          plan.createdName = r.name || name;
          return;
        } catch (e) {
          lastErr = e;
          if (!/exist|already|taken|used|duplicate/i.test(e.message)) break;
        }
      }
      throw lastErr;
    }, { fatal: true });

    // ---- 2. informações ----
    step("Limites e arquivos de E/S", async () => {
      const info = { interactive: plan.interactive ? "true" : "false" };
      if (plan.inputFile) info.inputFile = plan.inputFile;
      if (plan.outputFile) info.outputFile = plan.outputFile;
      if (plan.timeLimit !== null) info.timeLimit = Math.min(15000, Math.max(250, Math.round(plan.timeLimit / 50) * 50));
      if (plan.memoryLimitMb !== null) info.memoryLimit = Math.min(1024, Math.max(4, plan.memoryLimitMb));
      await client.call("problem.updateInfo", { ...P(), ...info });
    });

    // ---- 3. enunciados ----
    for (const s of plan.statements) {
      step(`Enunciado (${s.lang})`, () => client.call("problem.saveStatement", { ...P(), encoding: "UTF-8", ...s }));
    }
    for (const r of plan.statementResources) {
      step(`Imagem do enunciado: ${r.name}`, async () =>
        client.call("problem.saveStatementResource", { ...P(), checkExisting: "false", name: r.name, file: await zip.read(r.path) }));
    }

    // ---- 4. arquivos (resources e sources) ----
    for (const f of plan.resources) {
      step(`Resource: ${f.name}`, async () => {
        const params = { ...P(), type: "resource", checkExisting: "false", name: f.name, file: await zip.read(f.path) };
        if (f.forTypes && f.stages && f.assets) Object.assign(params, { forTypes: f.forTypes, stages: f.stages, assets: f.assets });
        await client.call("problem.saveFile", params);
      });
    }
    for (const f of plan.sources) {
      step(`Fonte: ${f.name}`, async () => {
        const params = { ...P(), type: "source", checkExisting: "false", name: f.name, file: await zip.read(f.path) };
        if (f.type) params.sourceType = f.type;
        await client.call("problem.saveFile", params);
      });
    }

    // ---- 5. checker / validator / interactor ----
    if (plan.checker) step(`Checker: ${plan.checker.name}`, () => client.call("problem.setChecker", { ...P(), checker: plan.checker.name }));
    if (plan.validators[0]) step(`Validator: ${plan.validators[0].name}`, () => client.call("problem.setValidator", { ...P(), validator: plan.validators[0].name }));
    if (plan.interactor) step(`Interactor: ${plan.interactor.name}`, () => client.call("problem.setInteractor", { ...P(), interactor: plan.interactor.name }));

    // ---- 6. soluções ----
    for (const s of plan.solutions) {
      step(`Solução: ${s.name} [${s.tag}]`, async () => {
        const params = { ...P(), checkExisting: "false", name: s.name, file: await zip.read(s.path), tag: s.tag };
        if (s.type) params.sourceType = s.type;
        await client.call("problem.saveSolution", params);
      });
    }

    // ---- 7. testes ----
    const anyPoints = plan.testsets.some((t) => t.tests.some((x) => x.points !== null));
    if (anyPoints) {
      step("Ativando pontuação", () => client.call("problem.enablePoints", { ...P(), enable: "true" }));
      if (plan.treatPointsAsPercent) step("Pontos do checker como porcentagem", () => client.call("problem.enableTreatPointsFromCheckerAsPercent", { ...P(), enable: "true" }));
    }
    for (const set of plan.testsets) {
      if (set.groups.length) {
        step(`Ativando grupos (${set.name})`, () => client.call("problem.enableGroups", { ...P(), testset: set.name, enable: "true" }));
        for (const g of set.groups) {
          step(`Grupo ${g.name} (${set.name})`, () => {
            const params = { ...P(), testset: set.name, group: g.name };
            if (g.pointsPolicy) params.pointsPolicy = g.pointsPolicy;
            if (g.feedbackPolicy) params.feedbackPolicy = g.feedbackPolicy;
            if (g.dependencies.length) params.dependencies = g.dependencies.join(",");
            return client.call("problem.saveTestGroup", params);
          });
        }
      }
      for (const t of set.tests) {
        step(`Teste ${set.name} #${t.index}`, async () => {
          const params = {
            ...P(), testset: set.name, testIndex: t.index, checkExisting: "false",
            testInput: await zip.read(t.path),
            testUseInStatements: t.sample ? "true" : "false"
          };
          if (t.group !== null && set.groups.length) params.testGroup = t.group;
          if (t.points !== null) params.testPoints = t.points;
          if (t.description) params.testDescription = t.description;
          await client.call("problem.saveTest", params);
        });
      }
    }

    // ---- 8. tags ----
    if (plan.tags.length) step("Tags", () => client.call("problem.saveTags", { ...P(), tags: plan.tags.join(",") }));

    const total = steps.length;
    for (const s of steps) {
      report(s.label, done, total);
      try { await s.fn(); }
      catch (e) {
        if (s.fatal) throw e;
        failures.push(`${s.label}: ${e.message}`);
      }
      done++;
    }
    report("Concluído", total, total);
    return { problemId, name: plan.createdName, failures };
  }

  /* =====================================================
   *  INTERFACE (página Problems do Polygon)
   * ===================================================== */
  const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : undefined;

  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...children);
    return e;
  }

  function mount() {
    if (document.getElementById("pgx-import-btn")) return;
    if (!/\/problems\/?$/.test(location.pathname)) return;

    const input = el("input", { type: "file", accept: ".zip,application/zip", id: "pgx-import-file" });
    input.hidden = true;
    const btn = el("button", { type: "button", id: "pgx-import-btn", textContent: "Importar zip" });
    btn.title = "Importa um pacote .zip exportado pelo Polygon como um novo problema";
    const status = el("div", { id: "pgx-import-status", className: "pgx-keep" });
    status.hidden = true;

    const anchor = document.querySelector("table.pgx-data, table") || document.body.firstElementChild;
    const bar = el("div", { className: "pgx-import-bar" }, btn, input, status);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
    else document.body.prepend(bar);

    const show = (html, cls = "") => { status.hidden = false; status.className = "pgx-keep " + cls; status.replaceChildren(...html); };
    const line = (t) => el("div", { textContent: t });

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      btn.disabled = true;
      try {
        const keys = await api.storage.local.get({ apiKey: "", apiSecret: "" });
        if (!keys.apiKey || !keys.apiSecret) {
          show([line("Configure a API key e o secret no popup da extensão (ícone do Polygon Plus). Gere-as em Settings → API do Polygon.")], "pgx-import-err");
          return;
        }
        show([line("Lendo " + file.name + "…")]);
        const zip = PgxZip.open(await file.arrayBuffer());
        const plan = await PgxPkg.parse(zip);

        const summary = PgxPkg.summarize(plan);
        if (!confirm(`Importar como novo problema?\n\n${summary}${plan.warnings.length ? `\n\nAvisos (${plan.warnings.length}):\n- ` + plan.warnings.slice(0, 8).join("\n- ") : ""}`)) {
          status.hidden = true;
          return;
        }

        const client = PgxApi.createClient({ apiKey: keys.apiKey, apiSecret: keys.apiSecret });
        const bar = el("progress", { max: 1, value: 0 });
        const label = line("Iniciando…");
        show([label, bar]);
        const result = await runImport({
          zip, plan, client,
          report: (text, d, t) => { label.textContent = `${text} (${d}/${t})`; bar.max = t || 1; bar.value = d; }
        });

        const link = el("a", { href: `/problems`, textContent: "Atualize a lista" });
        const out = [line(`Problema "${result.name}" criado (id ${result.problemId}).`)];
        const issues = [...plan.warnings, ...result.failures];
        if (issues.length) {
          out.push(line(`${issues.length} aviso(s)/falha(s):`));
          out.push(el("ul", {}, ...issues.slice(0, 30).map((m) => el("li", { textContent: m }))));
        }
        out.push(link);
        show(out, result.failures.length ? "pgx-import-warn" : "pgx-import-ok");
      } catch (e) {
        show([line("Falha na importação: " + (e && e.message ? e.message : e))], "pgx-import-err");
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (typeof document !== "undefined" && typeof api !== "undefined") {
    const go = () => mount();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  }

  globalThis.PgxImport = { runImport };
})();
