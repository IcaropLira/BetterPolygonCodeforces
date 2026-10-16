const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = { dark: true, modern: true, wide: true, filter: true, verdicts: true, shortcuts: true, tabindent: false, totop: true, copy: true, accent: "#4f7cff", density: "comfortable" };

api.storage.local.get(DEFAULTS).then((cfg) => {
  document.querySelectorAll("input[data-key]").forEach((cb) => {
    cb.checked = !!cfg[cb.dataset.key];
    cb.addEventListener("change", () => api.storage.local.set({ [cb.dataset.key]: cb.checked }));
  });
  document.querySelectorAll('input[name="accent"]').forEach((r) => {
    r.checked = r.value === cfg.accent;
    r.addEventListener("change", () => api.storage.local.set({ accent: r.value }));
  });
  const d = document.getElementById("density");
  d.value = cfg.density;
  d.addEventListener("change", () => api.storage.local.set({ density: d.value }));
});
