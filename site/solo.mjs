// LOCAL ONLY (never pushed). One viewer at full size, so nothing else shares its thread
// (the side-by-side page puts every pane on one thread: one slow parser stalls them all).
// Same pane contract as side-by-side.mjs; the camera path and viewpoints come from
// tools/camera-path.mjs through the pane's window.__benchCamera (same origin).
//
//   ?tool=scenoptic-webgpu&model=sixty5&form=sgpu   preselect; &autoload=1 loads at once
// local (trajet 2) : &bare=1 masque les barres (pour filmer) ; &spinSpeed=90 &spinEl=0 &spinH=0 &spinS=12 règlent la rotation ;
// window.__spin(at) la lance à l'instant at (Date.now()) : scripts/spin-video.mjs s'en sert pour filmer chaque viewer.

const { panes } = await fetch("./panes.json").then((r) => r.json());
const manifest = await fetch("../models/manifest.json").then((r) => r.json());
const $ = (id) => document.getElementById(id);
const toolSel = $("tool"), modelSel = $("model"), formSel = $("form"), frame = $("pane"), status = $("status");
const query = new URLSearchParams(location.search);
if (query.get("bare") === "1") document.body.classList.add("bare");
if (query.get("spinSpeed")) $("spinSpeed").value = query.get("spinSpeed");

const option = (sel, value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; sel.append(o); };
for (const p of panes) option(toolSel, p.tool, `${p.title}`);
for (const m of manifest.models) option(modelSel, m.id, `${m.title} (${(m.bytes / 1e6).toFixed(1)} MB IFC)`);
const spec = () => panes.find((p) => p.tool === toolSel.value);
function fillForms() {
  formSel.textContent = "";
  for (const f of spec().forms) option(formSel, f, `.${f}`);
}
toolSel.value = query.get("tool") ?? panes[0].tool;
fillForms();
modelSel.value = query.get("model") ?? "duplex";
if (query.get("form")) formSel.value = query.get("form");

let ready = false, states = [], version = "", loaded = false, multi = false;
// The GPU that draws this page, read once: Chrome may switch adapter (driver update, Windows setting).
const gpuName = (() => {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const r = gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "WebGL indisponible";
    return (r.split(",")[1] ?? r).replace(/\(0x[0-9a-f]+\)/i, "").replace(/Direct3D.*$/, "").trim();
  } catch { return "GPU inconnu"; }
})();
const ms = (t) => `${Math.round(t)} ms`;
const line = (extra = "") => {
  const s = states.map((x) => `<span class="${x.state}">${x.state} ${ms(x.t)}</span>`).join("  →  ");
  status.innerHTML = `[${gpuName}]  ${spec().title} ${version}  ·  ${modelSel.value}.${formSel.value}  ·  ${s || (ready ? "prêt" : "chargement du viewer…")}${extra ? `\n${extra}` : ""}`;
};
const buttons = () => document.querySelectorAll("#path, #spin, [data-pose]").forEach((b) => { b.disabled = !loaded; });

// A new viewer = a new iframe: a fresh page, as the suite gives each load a fresh Chrome tab.
function openPane() {
  ready = false; loaded = false; states = []; version = "";
  buttons();
  // local (#796) : les réglages du viewer (gpu…, renderer…) passés à la page solo vont au pane.
  const fwd = new URLSearchParams([...query].filter(([k]) => !["tool", "model", "form", "autoload"].includes(k)));
  frame.src = `../tools/${toolSel.value}/pane.html${fwd.size ? `?${fwd}` : ""}`;
  line();
}
toolSel.addEventListener("change", () => { fillForms(); openPane(); });

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (m?.type === "ready") {
    ready = true; version = m.version ?? ""; multi = !!m.multi;
    line();
    if (query.get("autoload") === "1" && !states.length) load();
  } else if (m?.type === "state") {
    states.push(m);
    if (["first-frame", "done", "failed"].includes(m.state)) $("veil").classList.remove("on"); // local (trajet 2)
    if (m.state === "done") { loaded = true; buttons(); }
    line(m.phases ? `phases ${JSON.stringify({ ...m.phases, engine: undefined })}` : m.message ?? "");
  }
});

function load() {
  if (!ready) return;
  // A second load in the same pane restarts it (contract); for a clean measure, reopen the page.
  states = []; loaded = false; buttons();
  // An assembly (manifest "parts") sends one file per part.
  // local : une pièce peut être { id, offset } (matrices d'assemblage) ; le décalage va au pane.
  const parts = (manifest.models.find((m) => m.id === modelSel.value)?.parts ?? [modelSel.value]).map((p) => (typeof p === "string" ? { id: p } : p));
  // local (trajet 2) : une forme « <x>-cache » lit le fichier <x> (ifc-cache : le .ifc, mis en cache par le viewer), comme side-by-side.mjs
  const fileExt = formSel.value.replace(/-cache$/, "");
  const urls = parts.map((p) => new URL(`../models/cache/${p.id}.${fileExt}`, location.href).href);
  const offsets = parts.some((p) => p.offset) ? parts.map((p) => p.offset ?? [0, 0, 0]) : undefined;
  if (urls.length > 1 && !multi) { states = [{ state: "failed", t: 0 }]; line(`ce viewer ne charge qu'un fichier à la fois ; ${modelSel.value} en a ${urls.length}`); return; }
  frame.contentWindow.postMessage({ type: "load", model: modelSel.value, url: urls[0], urls, offsets, form: formSel.value }, "*");
  $("veil").classList.add("on");
  $("sync").style.background = "#fff"; // local (trajet 2) : repère t = 0 du chargement pour le montage vidéo
  line();
}
$("load").addEventListener("click", () => { if (states.length) { openPane(); query.set("autoload", "1"); } else load(); });

const cam = () => frame.contentWindow.__benchCamera;
$("path").addEventListener("click", async () => {
  if (!cam()) return line("ce pane n'a pas d'adaptateur caméra");
  buttons(); document.querySelectorAll("#path, [data-pose]").forEach((b) => { b.disabled = true; });
  line("trajet en cours (20 s)…");
  const r = await cam().playPath();
  loaded = true; buttons();
  const s = r.stats;
  line(r.error ? `trajet : ${r.error}` : `trajet : ${s.fps} img/s · p50 ${s.p50} ms · p95 ${s.p95} ms · p99 ${s.p99} ms · max ${s.max} ms · > 33 ms : ${s.over33} · ${s.frames} images`);
});
document.querySelectorAll("[data-pose]").forEach((b) => b.addEventListener("click", () => cam()?.pose(b.dataset.pose)));

// local (trajet 2) : caméra au centre de la boîte de la maquette, qui tourne sur elle-même. Chaque image fait entrer une
// bande de scène dans le champ : un viewer qui tarde à afficher ce qui entre dans le champ le montre aussitôt. La pose passe
// par poseRaw (tools/camera-path.mjs, commun à tous les panes) ; l'œil reste au centre (+ spinH × R en hauteur) et regarde
// dans la direction -dir de toWorld, d'où look = -dir × dist. L'angle suit l'horloge murale, pas le nombre d'images :
// deux viewers lancés au même instant ont le même angle au même moment, quelle que soit leur cadence.
const DEG = Math.PI / 180;
export function spinPose(azDeg, elDeg = 0, h = 0) {
  const d = 0.3, az = azDeg * DEG, el = elDeg * DEG;
  return { az: azDeg, el: elDeg, dist: d, look: [-Math.cos(az) * Math.cos(el) * d, -Math.sin(az) * Math.cos(el) * d, -Math.sin(el) * d + h] };
}
// Trajet 2 complet : vue d'ensemble en plongée (holdS), descente adoucie vers le centre (flyS), puis rotation (spinS).
// La descente interpole les paramètres de pose : à la fin, look = -dir(0, el) × dist, donc l'œil est au centre.
const ease3 = (x) => x * x * (3 - 2 * x);
function trajPose(tMs, o) {
  const tS = tMs / 1000;
  const top = { az: 0, el: o.topEl, dist: o.topDist, look: [0, 0, 0] }, centre = o.orbit ? orbitPose(0, o) : spinPose(0, o.el, o.h);
  if (tS < o.holdS) return top;
  if (tS < o.holdS + o.flyS) {
    const k = ease3((tS - o.holdS) / o.flyS), mix = (a, b) => a + (b - a) * k;
    return { az: 0, el: mix(top.el, centre.el), dist: mix(top.dist, centre.dist), look: top.look.map((v, i) => mix(v, centre.look[i])) };
  }
  return o.orbit ? orbitPose(o.speed * (tS - o.holdS - o.flyS), o) : spinPose((o.speed * (tS - o.holdS - o.flyS)), o.el, o.h);
}
// local (trajet 2, variante) : &orbit=<dist en R> tourne AUTOUR de la maquette (regard vers le centre) au lieu de tourner
// sur place ; utile pour un bâtiment seul, dont le centre tombe à l'intérieur.
function orbitPose(azDeg, o) { return { az: azDeg, el: o.orbitEl, dist: o.orbit, look: [0, 0, 0] }; }
const trajOpts = () => ({ speed: Number($("spinSpeed").value), el: Number(query.get("spinEl") ?? 0), h: Number(query.get("spinH") ?? 0),
  spinS: Number(query.get("spinS") ?? 12), holdS: Number(query.get("holdS") ?? 1.5), flyS: Number(query.get("flyS") ?? 3),
  topEl: Number(query.get("topEl") ?? 60), topDist: Number(query.get("topDist") ?? 1.4),
  orbit: Number(query.get("orbit") ?? 0), orbitEl: Number(query.get("orbitEl") ?? 15) });
let spinRun = 0;
async function spin(at = Date.now()) {
  const c = cam(), w = frame.contentWindow;
  if (!c?.poseRaw) { line("ce pane n'a pas de poseRaw"); return null; }
  const run = ++spinRun, o = trajOpts(), durMs = (o.holdS + o.flyS + o.spinS) * 1000;
  const next = () => new Promise((r) => w.requestAnimationFrame(r));
  await c.poseRaw(trajPose(0, o)); // en place avant le départ commun
  while (Date.now() < at) await next();
  line(`trajet 2 : vue d'ensemble, descente, rotation à ${o.speed} °/s…`);
  let frames = 0;
  for (;;) {
    const t = Date.now() - at;
    if (t > durMs || run !== spinRun) break;
    await c.poseRaw(trajPose(t, o));
    await next(); frames++;
  }
  const res = { frames, ms: Date.now() - at, speed: o.speed, holdS: o.holdS, flyS: o.flyS, spinS: o.spinS };
  line(`trajet 2 : ${frames} images en ${(res.ms / 1000).toFixed(1)} s (${(frames / (res.ms / 1000)).toFixed(0)} img/s)`);
  return res;
}
$("spin").addEventListener("click", () => spin(Date.now() + 300));
window.__spin = (at) => spin(at);
window.__spinPlace = async () => { await cam()?.poseRaw(trajPose(0, trajOpts())); }; // pose de départ (vue d'ensemble)
window.__soloLoaded = () => loaded;
window.__soloReady = () => ready;
// le voile est peint avant le chargement : un viewer qui bloque aussitôt le fil principal ne l'empêche plus
window.__soloLoad = async () => { $("veil").classList.add("on"); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); load(); };

openPane();
