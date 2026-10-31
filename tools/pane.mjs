// Shared by every pane page. The contract is in tools/README.md.
//
//   createPane({ tool, version, ext, load, multi })
//
// local (#796, never pushed): an assembly (a manifest model with "parts") comes as `urls`, one
// file per part, in the load message; `url` is then the first part. A pane that can load several
// files at once passes `multi: true` and reads `urls`; any other pane fails the load with a
// message instead of quietly showing one part.
//
// `ext` is the file form this pane reads ("glb", "ifc", "bos", ...). `load` is
// called with { model, url, report } once per load, from a message of the
// parent page or, when the page is opened on its own, from ?model= / ?url=.
// `report(state, extra)` sends { type: "state", state, t, ...extra } to the
// parent and prints it in the status line.

// "?model=duplex" -> /models/cache/duplex.glb; "?url=..." is used as given.
export function resolveTarget(search, ext) {
  const q = new URLSearchParams(search);
  const url = q.get("url");
  const model = q.get("model") ?? (url ? url.split("/").pop().replace(/\.[^.]*$/, "") : undefined);
  if (url) return { model, url };
  if (model) return { model, url: `/models/cache/${model}.${ext}` };
  return undefined;
}

export function formatState(msg) {
  const bytes = msg.bytes == null ? "" : `  ${msg.bytes} bytes`;
  const text = msg.message ? `  ${msg.message}` : "";
  return `${msg.state}  ${Math.round(msg.t)} ms${bytes}${text}`;
}

export function createPane({ tool, version, ext, load, multi = false, win = window }) {
  const doc = win.document;
  const embedded = win.parent && win.parent !== win;
  let line = doc.getElementById("status");
  // Inside the side-by-side page the parent shows its own line per pane, so the
  // pane's line would only repeat it and wrap in a narrow slot. Messages still go out.
  if (!line) {
    line = doc.createElement("div");
    line.id = "status";
    line.style.cssText = "font:12px monospace;padding:2px 6px;background:#222;color:#eee;white-space:pre";
    doc.body.prepend(line);
  }
  if (embedded) line.hidden = true;
  // The credit beside a pane's logo (a <span> in #logo naming the company): one rule for every pane.
  const credit = doc.createElement("style");
  credit.textContent = "#logo span { font: 600 12px system-ui, sans-serif; color: #7d8490; white-space: nowrap; }";
  doc.head.append(credit);
  let origin = win.performance.now();
  let current = { model: "", url: "" };
  let history = [];

  const post = (msg) => { if (win.parent && win.parent !== win) win.parent.postMessage(msg, "*"); };
  const report = (state, extra = {}) => {
    const msg = { type: "state", state, t: win.performance.now() - origin, ...extra };
    history.push(formatState(msg));
    line.textContent = `${tool} ${current.model}: ${history.join("  >  ")}`;
    line.dataset.state = state;
    post(msg);
    return msg;
  };
  // local (#796) : `offsets` = décalage [x, y, z] (m, monde Y-up) de chaque fichier, matrices d'assemblage ; null = aucun.
  // local (rebench, 26/10) : `form` = la forme demandée par la page parente (ifclite : « ifc-cache » lit le même .ifc).
  const start = (model, url, urls, offsets, form) => {
    origin = win.performance.now();
    current = { model, url };
    history = [];
    if (urls && urls.length > 1 && !multi) { report("failed", { message: `${tool} loads one file at a time; ${model} has ${urls.length}` }); return; }
    load({ model, url, urls: urls ?? [url], offsets: offsets ?? null, report, form });
  };

  win.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.type === "load" && typeof m.url === "string") start(m.model ?? "", m.url, Array.isArray(m.urls) ? m.urls : undefined, Array.isArray(m.offsets) ? m.offsets : undefined, typeof m.form === "string" ? m.form : undefined);
  });
  post({ type: "ready", tool, version, multi });
  line.textContent = `${tool} ${version}: ready`;

  const target = resolveTarget(win.location.search, ext);
  if (target) start(target.model, target.url);
}
