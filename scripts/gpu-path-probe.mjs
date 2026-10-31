// LOCAL ONLY (rebench tâche 5) : sonde de trajet commune à tous les panes (Scenoptic WebGL/WebGPU, That Open WebGL/WebGPU).
//   node scripts/gpu-path-probe.mjs --tool <pane> --model <id> --form <f> --out <json> [--shots <dir>] [--headed] [--qs <a=b&c=d>]
//        [--rep <n>] [--timeout <s>] [--expect-version <sha>]
// Revue finale (vague unique) :
//   C1  cadence imposée : un pas de trajet toutes les 1000 / STEP_HZ ms d'horloge (30 Hz par défaut, témoin 60) pour TOUS les viewers (pose virtuelle
//       t = k × 1000 / STEP_HZ ms, donc 601 poses à 30 Hz (1 201 à 60 Hz) identiques partout) ; on attend l'image du pas, puis l'échéance ; on ne rattrape
//       pas : un pas plus long que 1000 / STEP_HZ ms est un dépassement (cadence.overruns). nvidia-smi échantillonné toutes les
//       200 ms pendant le trajet (best effort, absent sur iGPU) : médiane et min de clocks.gr / clocks.mem / power.draw.
//   C2  passe de contrôle du boost : les compteurs du culling GPU de Scenoptic n'ont qu'UNE copie en vol, prise à la
//       première image après la lecture précédente ; au repos, cette copie est celle de l'image du SAUT de pose (pyramide
//       Hi-Z de la pose précédente) : on la lit et la jette (restJump), puis on relit une image en régime ; le trajet de
//       la passe suit la même cadence et les mêmes poses que la mesure (paires à 0 ms) ; critère durci (path-stats).
//   C4  version de conversion (models/cache/<id>.<forme>.json) copiée dans la sortie (conversion) et contrôlée.
//   Imp 4  __gpuW.reset() (et COUNTER / GPUTIMER remis à zéro) après « done » ; Imp 8  draws WebGL hors rAF > 5 % ⟹
//       non mesuré ; Imp 9  délai de chargement = --timeout (900 s, comme view.mjs), « délai dépassé ».
// Temps GPU par image :
//   WebGL  : timer query autour de chaque callback rAF (GPUTIMER, copie de fair-probe dans lib/webgl-probes.mjs) ;
//   WebGPU : timestampWrites sur chaque passe (WEBGPU_TIMER_SOURCE, lib/webgpu-timer.mjs), TOTAL de l'image.
// Déroulé : Chrome neuf (benchProfile), sans vsync ni limite de fréquence, --enable-webgpu-developer-features ; pane chargé
// par solo.html?autoload=1 (barres de statut sur une ligne : même canvas CANVAS_W × CANVAS_H pour tous les panes) ; à « done » :
// vue iso, 15 s de repos non mesurées, puis le repos en deux mesures : rest.idleGpuMsPerSec = travail GPU par seconde
// pendant 3 s SANS demande de rendu (Scenoptic dessine à la demande : ≈ 0 ; That Open redessine à chaque tick) et
// rest.staticFrameMs = médiane de STATIC_FRAMES images FORCÉES à la même pose (requestRender, ou image suivante chez un
// viewer qui dessine en continu), une valeur par image forcée ; trajet de 20 s (cam.setAt(t)), puis les 11 instants du
// trajet (0, 2, …, 20 s), 600 ms chacun (viewpoints). --shots : PNG aux 11 instants et en mouvement à t = 2, 6, 13 s
// (image prise juste après le pas de caméra, sans attente de repos).
// Trajet : à chaque pas, pose, demande de rendu, image d'animation, puis attente de l'image GPU terminée, de façon
// équivalente des deux côtés : fenceSync(SYNC_GPU_COMMANDS_COMPLETE) signalé en WebGL (les timer queries se relisent
// en différé), onSubmittedWorkDone en WebGPU. path.* = UNE image par pas : la première image GPU avec travail après le
// début du pas (perStepFrames) ; les images rendues ensuite à la même pose (attente du GPU, viewer qui dessine à chaque
// tick) ne vont qu'à pathAllFrames. Le temps du trajet est VIRTUEL : les captures en mouvement n'en consomment pas.
// Contrôle du boost : triangles par image aux 11 instants, au repos contre en mouvement (pas le plus proche) ; capteur
// par image = COUNTER (WebGL), draws WebGPU directs, ou, chez Scenoptic WebGPU (draws indirects, getDebugStats = total
// chargé), une passe NON mesurée avec les compteurs de culling GPU (setGpuCullCounters / readGpuDrawCounters).
// Verrou du banc (lib/bench-lock.mjs, même fichier que view.mjs) tenu du lancement de Chrome à sa fermeture ; les autres
// Chrome du banc (profils D:/tmp/bench-profiles qui ne sont pas le nôtre) sont relevés au début et à la fin (benchContext).
// Code de sortie : 0 ; 1 erreur ; 2 chargement non terminé (dont délai dépassé) ; 3 device perdu / contexte WebGL perdu / onglet planté.
//
// Écart au plan : VIEWPOINTS de tools/camera-path.mjs ne compte que 3 poses nommées (iso, front, inside) ; les « 11 instants »
// du plan et de la conception sont les instants 0, 2, …, 20 s de poseAt (PATH_MS / 10), rejoués par cam.setAt(t).
// VIEWPOINTS.iso sert à la vue de repos (cam.pose("iso")).
import { benchProfile } from "./lib/bench-profile.mjs";
import { WEBGPU_TIMER_SOURCE } from "./lib/webgpu-timer.mjs";
import { COUNTER, GPUTIMER } from "./lib/webgl-probes.mjs";
import { boostRatios, boostVerdict, gpuMsPerSecond, pathSummary, perStepFrames, smiSummary } from "./lib/path-stats.mjs";
import { conversionCheck, DEFAULT_EXPECTED_SHA, LOAD_TIMEOUT_S } from "./lib/rebench-matrix.mjs";
import { readManifest } from "./lib/manifest.mjs";
import { cacheDir } from "./lib/paths.mjs";
import { acquireBenchLock, BENCH_LOCK_PATH, readBenchLock } from "./lib/bench-lock.mjs";
import { PATH_MS, VIEWPOINTS, poseAt, toWorld } from "../tools/camera-path.mjs";
import { spawn, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startServer } from "./serve.mjs";

// --- arguments ---
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) throw new Error(`argument inattendu : ${a}`);
  const k = a.slice(2);
  if (k === "headed") args.headed = true;
  else args[k] = process.argv[++i];
}
for (const k of ["tool", "model", "form", "out"]) if (!args[k]) throw new Error("usage : node scripts/gpu-path-probe.mjs --tool <pane> --model <id> --form <f> --out <json> [--shots <dir>] [--headed]");
if (!VIEWPOINTS.iso) throw new Error("VIEWPOINTS.iso absent de tools/camera-path.mjs");
mkdirSync(dirname(args.out), { recursive: true });
if (args.shots) mkdirSync(args.shots, { recursive: true });

const REST_IDLE_MS = Number(process.env.REST_IDLE_MS ?? 15000), REST_MS = 3000, VIEW_MS = 600; // REST_IDLE_MS : diagnostic seulement
const CANVAS_W = 1264, CANVAS_H = 600; // px du canvas attendus (barres de statut à 18 px, voir PROBE_SOURCE) ; That Open en a 601 : écart de 1 px consigné (canvasDeltaPx)
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS ?? 60000);
const INSTANTS = Array.from({ length: 11 }, (_, i) => Math.round((i * PATH_MS) / 10)); // 0, 2000, …, 20000
const MOVING_SHOTS = [2000, 6000, 13000];
const TAG_REST = 1, TAG_PATH = 2, TAG_IDLE = 3, TAG_VIEW0 = 10;
const STATIC_FRAMES = 30; // images forcées à pose fixe (rest.staticFrameMs)
const ALL_TAGS = [TAG_REST, TAG_PATH, TAG_IDLE, ...INSTANTS.map((_, i) => TAG_VIEW0 + i)];
// C1 : pas de trajet à cadence d'horloge fixe (STEP_HZ) ; la pose k est t = k × 1000 / STEP_HZ ms (2 000, 6 000, 13 000 et 20 000 ms tombent juste).
// 26/10 : 30 Hz par défaut (décision utilisateur) ; STEP_HZ=60 = témoin. Les instants ci-dessus tombent juste aux deux cadences.
const STEP_HZ = Number(process.env.STEP_HZ ?? 30);
if (![30, 60].includes(STEP_HZ)) { console.error(`STEP_HZ=${process.env.STEP_HZ} : 30 ou 60 seulement`); process.exit(2); }
const LOAD_TIMEOUT_MS = Number(args.timeout ?? LOAD_TIMEOUT_S) * 1000;
const PATH_EVAL_TIMEOUT_MS = 15 * 60000; // C1 : le trajet compte 1 201 pas quel que soit le viewer (105 ms par pas chez That Open WebGL sur iGPU : 2 min)
const PAIR_TOL_MS = 1; // paires repos / mouvement : même pose (les deux passes suivent la même grille de poses)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- relevé d'alimentation (best effort) ---
function readPower() {
  const run = (cmd, a) => { try { const r = spawnSync(cmd, a, { encoding: "utf8", timeout: 10000 }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };
  const scheme = run("powercfg", ["-getactivescheme"]);
  const nv = run("nvidia-smi", ["--query-gpu=name,power.limit,power.draw", "--format=csv,noheader"]);
  // powercfg écrit dans la page de code OEM : on ne garde que le GUID et le nom du mode.
  const sm = scheme?.match(/([0-9a-f]{8}-[0-9a-f-]{27})\s*\(([^)]*)\)/i);
  return { scheme: sm ? `${sm[1]} (${sm[2]})` : scheme ? scheme.replace(/\s+/g, " ") : null, nvidia: nv ? nv.split(/\r?\n/).map((l) => l.trim()) : null };
}

// --- crochets supplémentaires, injectés dans chaque document (pane compris) après les trois sondes ---
// Devices WebGPU (pour onSubmittedWorkDone), triangles WebGPU estimés (draw/drawIndexed, topologie du pipeline ; les
// draws indirects sont seulement comptés), perte de contexte WebGL, indices d'anticrénelage (MSAA), dernier horodatage
// rAF et journal des rAF, caméra perspective réellement rendue (crochet __THREE_DEVTOOLS__ de three : renderer.render).
const PROBE_SOURCE = `(() => { if (self.__probe) return;
  // Même taille de canvas partout : les barres de statut (solo.html et pane) restent sur UNE ligne, dès le chargement
  // (une barre repliée sur deux lignes chez That Open, au texte de version plus long, rognait 13 px de canvas ; redimensionner
  // l'iframe après coup ne marche pas : le pane Scenoptic ne suit pas le redimensionnement).
  const css = () => { const st = document.createElement("style"); st.textContent = "#status{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;height:18px!important;min-height:0!important;box-sizing:border-box!important}"; (document.head || document.documentElement).append(st); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", css); else css();
  const P = self.__probe = { devs: [], glLost: null, wgpu: { t: 0, d: 0, ind: 0 }, msaa: { maxSampleCount: 1, msaaTextures: 0, resolvePasses: 0, passes: 0 }, lastRafTs: -1, rafLog: null, cam: null, renderers: 0 };
  const raf = self.requestAnimationFrame;
  if (raf) self.requestAnimationFrame = function (cb) { return raf.call(this, (ts) => { if (ts !== P.lastRafTs) { P.lastRafTs = ts; if (P.rafLog) P.rafLog.push(ts); } return cb(ts); }); };
  if (typeof self.__THREE_DEVTOOLS__ === "undefined") { const dt = self.__THREE_DEVTOOLS__ = new EventTarget();
    dt.addEventListener("observe", (e) => { const r = e.detail; if (!r || typeof r.render !== "function" || !(r.isWebGLRenderer || r.isRenderer || r.isWebGPURenderer) || r.__probeCam) return; r.__probeCam = 1; P.renderers++;
      const o = r.render; r.render = function (scene, camera, ...a) { if (camera && camera.isPerspectiveCamera) P.cam = camera; return o.call(this, scene, camera, ...a); }; }); }
  if (self.GPUAdapter) {
    const A = self.GPUAdapter.prototype, rd = A.requestDevice;
    A.requestDevice = async function (...a) { const d = await rd.apply(this, a); P.devs.push(d); return d; };
    const D = self.GPUDevice.prototype, topo = new WeakMap(), cur = new WeakMap();
    const crp = D.createRenderPipeline; D.createRenderPipeline = function (desc) { const p = crp.call(this, desc); topo.set(p, desc?.primitive?.topology ?? "triangle-list"); return p; };
    const crpa = D.createRenderPipelineAsync; if (crpa) D.createRenderPipelineAsync = async function (desc) { const p = await crpa.call(this, desc); topo.set(p, desc?.primitive?.topology ?? "triangle-list"); return p; };
    const ct = D.createTexture; D.createTexture = function (desc) { const s = desc?.sampleCount ?? 1; if (s > 1) { P.msaa.msaaTextures++; if (s > P.msaa.maxSampleCount) P.msaa.maxSampleCount = s; } return ct.call(this, desc); };
    const E = self.GPUCommandEncoder.prototype, brp = E.beginRenderPass;
    E.beginRenderPass = function (desc) { P.msaa.passes++; if ((desc?.colorAttachments ?? []).some((c) => c && c.resolveTarget)) P.msaa.resolvePasses++; return brp.call(this, desc); };
    const R = self.GPURenderPassEncoder.prototype;
    const tri = (enc, n) => { const t = cur.get(enc) ?? "triangle-list"; return t === "triangle-list" ? n / 3 : t === "triangle-strip" ? Math.max(0, n - 2) : 0; };
    const sp = R.setPipeline; R.setPipeline = function (p) { cur.set(this, topo.get(p)); return sp.call(this, p); };
    const dr = R.draw; R.draw = function (vc, ic = 1, ...a) { P.wgpu.t += tri(this, vc) * ic; P.wgpu.d++; return dr.call(this, vc, ic, ...a); };
    const di = R.drawIndexed; R.drawIndexed = function (n, ic = 1, ...a) { P.wgpu.t += tri(this, n) * ic; P.wgpu.d++; return di.call(this, n, ic, ...a); };
    for (const k of ["drawIndirect", "drawIndexedIndirect"]) { const o = R[k]; if (o) R[k] = function (...a) { P.wgpu.ind++; P.wgpu.d++; return o.apply(this, a); }; }
  }
  const gc = self.HTMLCanvasElement?.prototype.getContext;
  if (gc) self.HTMLCanvasElement.prototype.getContext = function (type, ...a) { const g = gc.call(this, type, ...a);
    if (g && /webgl/.test(type) && !this.__probeLost) { this.__probeLost = 1; this.addEventListener("webglcontextlost", () => { P.glLost = "webglcontextlost"; }); } return g; };
})()`;

// --- pilote, évalué dans le pane une fois chargé (s'appuie sur __gpuT, __gpuW, __tri, __probe, __benchCamera) ---
const DRIVER_SOURCE = `(() => { const w = self, P = w.__probe, cam = w.__benchCamera;
  const v = () => w.viewer; // Scenoptic l'expose ; That Open dessine à chaque tick sans demande
  const fr = () => new Promise((r) => w.requestAnimationFrame(r));
  const yieldTask = () => new Promise((r) => setTimeout(r, 0));
  // C1 : attente jusqu'à une échéance d'horloge, sans le pincement à 4 ms des setTimeout imbriqués : setTimeout jusqu'à
  // ~3 ms de l'échéance, puis des tâches MessageChannel (non bridées) jusqu'à l'échéance.
  const mc = new MessageChannel(); const mq = []; mc.port1.onmessage = () => { const f = mq.shift(); if (f) f(); };
  const macro = () => new Promise((r) => { mq.push(r); mc.port2.postMessage(0); });
  const until = async (deadline) => { for (;;) { const left = deadline - performance.now(); if (left <= 0) return; if (left > 4) await new Promise((r) => setTimeout(r, left - 3)); else await macro(); } };
  const STEP = 1000 / ${STEP_HZ};
  const setTag = (t) => { if (w.__gpuT) w.__gpuT.tag = t; if (w.__gpuW) w.__gpuW.tag = t; };
  // Perte : device perdu (sauf destroy() volontaire, raison « destroyed ») ou contexte WebGL perdu.
  const lost = () => { const g = w.__gpuW && w.__gpuW.lost; return (g && !/^\\s*destroyed/.test(g) ? g : null) || P.glLost || null; };
  // Image GPU terminée, de façon équivalente des deux côtés : après les autres callbacks rAF de l'image (tâche suivante),
  // file WebGPU vide (onSubmittedWorkDone) ; en WebGL, fence SYNC_GPU_COMMANDS_COMPLETE signalée sur chaque contexte sondé.
  // 26/10 : deadline (pas du trajet) = on n'attend pas l'image GPU au-delà de l'échéance du pas. That Open WebGL redessine en
  // continu : la fence attendait 108 ms par pas (358 ms avec effets), la caméra avançait à 9 Hz au lieu de 30. Le temps GPU
  // par image reste lu en différé (requêtes de minuteur rattachées au rAF du pas, drainAll) ; seule la cadence change.
  const waitGpu = async (deadline = Infinity) => { await yieldTask(); const t0 = performance.now(); const lim = Math.min(5000, deadline - t0);
    if (P.devs.length) await Promise.race([Promise.all(P.devs.map((d) => d.queue.onSubmittedWorkDone().catch(() => {}))), new Promise((r) => setTimeout(r, Math.max(0, lim)))]);
    const T = w.__gpuT; if (T && T.ctxs.length) { const syncs = [];
      for (const c of T.ctxs) { try { const g = c.g; if (g.isContextLost()) continue; const s = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0); g.flush(); if (s) syncs.push([g, s]); } catch {} }
      let polls = 0; while (syncs.length && performance.now() - t0 < lim && !syncs.every(([g, s]) => g.getSyncParameter(s, g.SYNC_STATUS) === g.SIGNALED)) { polls++; await yieldTask(); }
      for (const [g, s] of syncs) { try { g.deleteSync(s); } catch {} } return polls; } return 0; };
  const resetTris = () => { if (w.__tri) { w.__tri.t = 0; w.__tri.d = 0; w.__tri.md = 0; w.__tri.l = 0; } P.wgpu.t = 0; P.wgpu.d = 0; P.wgpu.ind = 0; };
  const readTris = () => { const s = v()?.renderBackend?.getDebugStats?.(); return { gl: w.__tri ? Math.round(w.__tri.t) : null, viewer: s && s.triangles != null ? s.triangles : null, wgpu: Math.round(P.wgpu.t), wgpuIndirect: P.wgpu.ind }; };
  // Un pas : clés de début (dernier rAF vu, dernier numéro d'image du crochet WebGPU), pose (t ms du trajet, ou rien),
  // demande de rendu, image d'animation, image GPU terminée. lat = début du pas → rAF de la sonde (latence, pas CPU).
  const step = async (t, raw, deadline) => { resetTris(); const start = performance.now(), rafKey = P.lastRafTs, frameKey = w.__gpuW ? w.__gpuW.frame() : 0;
    if (raw) await cam.poseRaw(raw); else if (t != null) await cam.setAt(t); v()?.requestRender?.(); const ts = await fr(); const lat = performance.now() - start; const tris = readTris(); const w0 = performance.now(); const polls = await waitGpu(deadline); const wait = performance.now() - w0;
    return { t, start, rafKey, frameKey, ts, lat, tris, wait, polls, gpuCut: deadline != null && performance.now() >= deadline }; };
  // Repos inactif : aucune demande de rendu, aucune pose ; on compte ce que le viewer dessine de lui-même.
  P.idle = async (ms, tag) => { setTag(tag); const t0 = performance.now(); await new Promise((r) => setTimeout(r, ms)); const dt = performance.now() - t0; setTag(0); return dt; };
  // Images forcées à pose fixe : n pas sans pose (requestRender si le viewer l'expose), une image GPU terminée chacun.
  // Micro-pas de caméra : la pose iso décalée de 1e-4° en azimut une fois sur deux, pour qu'un viewer qui ne redessine que
  // sur un changement de caméra (That Open WebGPU) rende bien une image complète ; requestRender en plus là où il existe.
  P.rest = async (n, tag, iso) => { await cam.pose("iso"); setTag(tag); const rows = []; for (let i = 0; i < n && !lost(); i++) rows.push(await step(null, { ...iso, az: iso.az + (i % 2 ? Number(self.__probeMicroDeg ?? 1e-4) : 0) })); setTag(0); return rows; };
  P.k = 0; P.pathRows = []; P.pathRaf = []; P.overruns = 0;
  // Remise à zéro des crochets après « done » (important 4) : spans WebGPU, images WebGL, compteur de draws hors rAF.
  P.resetHooks = () => { if (w.__gpuW && w.__gpuW.reset) w.__gpuW.reset(); if (w.__gpuT) { w.__gpuT.done.length = 0; } if (w.__tri && w.__tri.rafReset) w.__tri.rafReset(); return 1; };
  // 26/10 : l'attente de l'image GPU est bornée par l'échéance du pas (gpuCut = image pas finie à l'échéance).
  // C1 : un pas toutes les STEP ms d'horloge. Pose k = k × STEP (grille commune à tous les viewers). On attend l'image GPU du
  // pas (step), puis l'échéance ; pas plus long que STEP ⟹ dépassement noté, le pas suivant part aussitôt (pas de rattrapage).
  P.pacedStep = async (t, onDone) => { const s0 = performance.now(); const r = await step(t, undefined, s0 + STEP - 4); // 4 ms de marge : granularité des sondages (setTimeout) if (onDone) r.extra = await onDone();
    r.dur = performance.now() - s0; r.over = r.dur > STEP; if (r.over) P.overruns++; else await until(s0 + STEP); return r; };
  // Tronçon du trajet jusqu'à l'instant virtuel toT (inclus : la grille tombe juste sur les coupes 2, 6, 13 et 20 s).
  P.pathSegment = async (toT, tag) => { setTag(tag); P.rafLog = [];
    while (!lost()) { const t = (P.k * 1000) / ${STEP_HZ}; if (t > toT + 1e-6) break; P.pathRows.push(await P.pacedStep(t)); P.k++; }
    P.pathRaf.push(P.rafLog); P.rafLog = null; setTag(0); return P.pathRows.length; };
  P.viewpoint = async (t, ms, tag) => { setTag(tag); const rows = []; await cam.setAt(t); const t0 = performance.now(); while (performance.now() - t0 < ms && !lost()) rows.push(await step(null)); setTag(0); return rows; };
  // Passe NON mesurée de contrôle du boost (Scenoptic WebGPU) : compteurs du culling GPU, triangles envoyés au GPU
  // (instances + grappes) aux 11 instants au repos (après ms), puis le long du trajet, même grille de poses et même cadence
  // que la mesure. Revue finale C2 : la copie des compteurs (une seule en vol, ClusterCuller._copyCounters) est prise à la
  // PREMIÈRE image qui suit la lecture précédente, donc, au repos, à l'image du saut de pose (pyramide Hi-Z de la pose
  // d'avant : occlusion quasi nulle). Cette lecture est gardée à part (restJump) et jetée ; rest = image en régime.
  P.boostPass = async (instants, ms, pathMs) => { const V = v(); if (!V || !V.readGpuDrawCounters || V.renderBackendKind !== "webgpu") return null;
    const readAll = async () => { const c = await V.readGpuDrawCounters(); return c ? { tris: c.triangles + c.clusterTriangles, inst: c.triangles, cl: c.clusterTriangles } : null; };
    const read = async () => { const c = await readAll(); return c ? c.tris : null; };
    V.setGpuCullCounters(true); setTag(0);
    try { const rest = [], restJump = [], restDetail = [];
      for (const t of instants) { await cam.setAt(t); const t0 = performance.now(); while (performance.now() - t0 < ms && !lost()) await step(null);
        restJump.push(await read()); // copie latente : image du saut de pose
        let c = null; for (let i = 0; i < 10 && c == null; i++) { await step(null); c = await readAll(); } rest.push(c ? c.tris : null); restDetail.push(c); }
      const move = []; let k = 0;
      for (;;) { if (lost()) break; const t = (k * 1000) / ${STEP_HZ}; if (t > pathMs + 1e-6) break; const r = await P.pacedStep(t, readAll); move.push({ t, tris: r.extra ? r.extra.tris : null, inst: r.extra ? r.extra.inst : null, cl: r.extra ? r.extra.cl : null }); k++; }
      return { rest, restJump, restDetail, move }; } finally { V.setGpuCullCounters(false); } };
  P.drainAll = async (tags) => { for (const tg of tags) { if (w.__gpuT) await w.__gpuT.drain(tg); if (w.__gpuW) await w.__gpuW.drain(tg); } };
  // Images GPU avec travail, avec leur clé : horodatage rAF (WebGL) ou numéro d'image (WebGPU).
  P.keyed = (tags) => { const o = { gl: {}, gpuW: {} }; for (const t of tags) {
      const m = new Map(); if (w.__gpuT) for (const [ts, tg, ms] of w.__gpuT.done) if (tg === t) m.set(ts, (m.get(ts) ?? 0) + ms);
      o.gl[t] = [...m].filter(([, ms]) => ms > 0.02).map(([key, ms]) => ({ key, ms }));
      o.gpuW[t] = w.__gpuW && w.__gpuW.framesById ? w.__gpuW.framesById(t).map((x) => ({ key: x.frame, ms: x.ms })) : []; } return o; };
  P.lost = lost;
  // Canvas principal (le plus grand), en px CSS et en px du tampon.
  P.canvas = () => { const cs = [...document.querySelectorAll("canvas")].map((c) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight })).sort((a, b) => b.cw * b.ch - a.cw * a.ch); return { main: cs[0] ?? null, all: cs }; };
  P.camState = () => { const c = P.cam; if (!c) return null; c.updateMatrixWorld?.(); const e = c.matrixWorld.elements; const r = (x) => Math.round(x * 1000) / 1000;
    return { eye: [e[12], e[13], e[14]].map(r), dir: [-e[8], -e[9], -e[10]].map(r), up: c.up.toArray().map(r), fov: r(c.fov), aspect: r(c.aspect), near: c.near, far: c.far }; };
  P.info = () => { const T = w.__gpuT, G = w.__gpuW, ex = w.__benchExtra ?? null;
    const gl = (T?.ctxs ?? []).map((c) => { const g = c.g; let renderer = null; try { const e = g.getExtension("WEBGL_debug_renderer_info"); renderer = e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : null; } catch {}
      let attrs = null; try { attrs = g.getContextAttributes(); } catch {} return { renderer, antialias: attrs ? attrs.antialias : null, samples: (() => { try { return g.getParameter(g.SAMPLES); } catch { return null; } })(), w: g.drawingBufferWidth, h: g.drawingBufferHeight }; });
    const partial = G ? G.spans.filter((s) => s.foreign && /\\.\\./.test(s.label ?? "")) : [];
    return { extra: ex ? JSON.parse(JSON.stringify(ex)) : null, rebenchLive: w.__benchRebenchRead ? w.__benchRebenchRead() : null, tocLive: w.__benchTocRead ? w.__benchTocRead() : null,
      gl, glRaf: w.__tri && w.__tri.raf ? { ...w.__tri.raf } : null, gpuW: G ? { devices: G.devices, counts: { ...G.counts }, unreliable: G.unreliable, quantized: G.quantized, lost: G.lost, spans: G.spans.length, pairedSpans: partial.length } : null, devs: P.devs.length, msaa: { ...P.msaa },
      partialByLabel: G && G.byLabel ? Object.fromEntries(Object.entries(G.byLabel(2)).filter(([k]) => k.includes(".."))) : null, threeRenderers: P.renderers, canvas: P.canvas(),
      passLabels: G && G.byLabel ? Object.keys(G.byLabel(2)).slice(0, 80) : null }; }; // revue finale, important 7 : étiquettes des passes du trajet (SMAA, FXAA…)
  return "ok"; })()`;


// Autres Chrome du banc (profil sous D:/tmp/bench-profiles qui n'est pas le nôtre), processus navigateur seulement.
function otherBenchChromes(mine) {
  try { const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'bench-profiles' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }"], { encoding: "utf8", timeout: 20000 });
    const slash = (p) => p.replaceAll(String.fromCharCode(92), "/"), norm = (p) => slash(p).toLowerCase();
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((l) => { const m = l.match(/^(\d+) .*--user-data-dir="?([^" ]+)/); return m ? { pid: Number(m[1]), profile: slash(m[2]) } : null; }).filter((x) => x && (!mine || norm(x.profile) !== norm(mine)));
  } catch { return null; } }
const power = readPower();
const lockOwnerAtStart = readBenchLock();
const lockT0 = Date.now();
const releaseLock = await acquireBenchLock(`gpu-path-probe ${args.tool} ${args.model}.${args.form}`);
const benchContext = { lockPath: BENCH_LOCK_PATH, lockFreeAtStart: !lockOwnerAtStart, lockOwnerAtStart, lockWaitMs: Date.now() - lockT0, othersSeenBefore: null, othersWaitMs: 0, othersAtStart: null, othersAtEnd: null, contended: false };
// Un autre Chrome du banc qui mesure (session qui n'utilise pas encore le verrou) fausserait les deux mesures : on attend
// qu'il se ferme (OTHERS_WAIT_MIN, défaut 45 min) ; au-delà, la mesure part et la ligne est marquée contended.
{ const t0 = Date.now(), maxMs = Number(process.env.OTHERS_WAIT_MIN ?? 45) * 60000; let o = otherBenchChromes(null); benchContext.othersSeenBefore = o;
  for (let k = 0; o?.length && Date.now() - t0 < maxMs; k++) { if (k % 4 === 0) console.log(`autre Chrome du banc : ${o.map((x) => `pid ${x.pid} (${x.profile})`).join(", ")} : attente…`); await sleep(15000); o = otherBenchChromes(null); }
  benchContext.othersWaitMs = Date.now() - t0; benchContext.othersAtStart = o; benchContext.contended = !!o?.length;
  if (o?.length) console.log("ATTENTION : autres Chrome du banc pendant la mesure :", JSON.stringify(o)); }
const server = await startServer(0);
const port = server.address().port;
const profile = benchProfile("gpath-");
// kit v2 (30/10) : PROBE_VSYNC=1 garde la vsync (60 Hz, comme chez un utilisateur) : passe de mesure CPU réaliste. Sans vsync
// (défaut, mesure GPU), un viewer qui dessine en boucle tourne à des centaines d images/s et son CPU en est gonflé.
const VSYNC = process.env.PROBE_VSYNC === "1";
const chromeArgs = [...(args.headed ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,800", "--no-first-run", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", ...(VSYNC ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]), "--enable-webgpu-developer-features", "about:blank"];
const proc = spawn(process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", chromeArgs, { stdio: "ignore" });
let ws;
for (let i = 0; i < 100 && !ws; i++) { try { const p = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\s+/)[0]; const t = await (await fetch(`http://127.0.0.1:${p}/json/new?about:blank`, { method: "PUT" })).json(); ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); } catch { ws = undefined; await sleep(200); } }
if (!ws) throw new Error("Chrome injoignable (DevTools)");
let id = 1; const pend = new Map(); const errors = []; let crashed = null;
// Onglet planté : toutes les requêtes en vol échouent tout de suite (sinon send attendrait sans fin).
const failAll = (why) => { for (const [, p] of pend) p.reject(new Error(why)); pend.clear(); };
ws.onmessage = ({ data }) => { const m = JSON.parse(data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "").slice(0, 300));
  if (m.method === "Inspector.targetCrashed" || m.method === "Target.targetCrashed") { crashed = "target crashed"; failAll(crashed); } };
ws.onclose = () => failAll("connexion DevTools fermée");
const send = (method, params = {}, timeoutMs = SEND_TIMEOUT_MS) => new Promise((resolve, reject) => { if (crashed) return reject(new Error(crashed)); const i = id++;
  const timer = setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error(`délai dépassé (${timeoutMs} ms) : ${method}`)); } }, timeoutMs);
  pend.set(i, { resolve, reject, timer }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e, timeoutMs) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, timeoutMs); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result?.result?.value; };
const PANE = `document.querySelector("iframe").contentWindow`;
const inPane = (body, timeoutMs) => ev(`(async () => { const w = ${PANE}; const P = w.__probe; ${body} })()`, timeoutMs);
const shot = async (name) => { if (!args.shots) return; const s = await send("Page.captureScreenshot", { format: "png" }); if (s.result?.data) writeFileSync(join(args.shots, `${args.tool}-${args.model}-${args.form}-${name}.png`), Buffer.from(s.result.data, "base64")); };
const med = (a) => pathSummary(a).med;
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const diffs = (a) => { const o = []; for (let i = 1; i < a.length; i++) o.push(a[i] - a[i - 1]); return o; };

const out = { tool: args.tool, form: args.form, model: args.model, version: null, adapter: null, power, backend: null,
  rest: { gpuMsMed: null, tris: null }, path: { gpuMsMed: null, gpuMsP95: null, gpuMsP99: null, frames: 0, tris: null, framesOver100ms: 0, over100Frac: 0 },
  benchContext, viewpoints: [], flags: { boostSuspect: false, boostChecked: false, boostCheck: null, tsQuantized: false, gpuUnmeasured: false, partialTiming: false, reason: null }, lost: null, aa: null, camera: null, status: null, errors };
const write = () => writeFileSync(args.out, JSON.stringify(out, null, 1));
// C4 : version de la conversion chargée, relue dans models/cache (assemblage : chaque partie), et contrôle.
{ const readRec = (n) => { try { return JSON.parse(readFileSync(join(cacheDir, n), "utf8")); } catch { return null; } };
  try { const ck = conversionCheck(args.model, args.form, { manifest: readManifest(), io: { exists: (n) => existsSync(join(cacheDir, n)), readRecord: readRec }, expectSha: args["expect-version"] ?? DEFAULT_EXPECTED_SHA });
    out.conversion = { versions: ck.versions, expectSha: args["expect-version"] ?? DEFAULT_EXPECTED_SHA }; out.conversionCheck = { ok: ck.ok, reason: ck.reason };
    if (!ck.ok) console.log(`ATTENTION conversion : ${ck.reason}`); } catch (e) { out.conversion = { error: String(e?.message ?? e) }; } }
out.rep = args.rep != null ? Number(args.rep) : null;
// C1 : échantillonneur nvidia-smi (best effort : absent sur iGPU ⟹ null).
function startSmi() {
  try { const p = spawn("nvidia-smi", ["--query-gpu=clocks.gr,clocks.mem,pstate,power.draw", "--format=csv,noheader,nounits", "-lms", "200"], { stdio: ["ignore", "pipe", "ignore"] });
    const lines = []; let tail = ""; p.on("error", () => {});
    p.stdout.on("data", (d) => { const a = (tail + d.toString("utf8")).split(/\r?\n/); tail = a.pop(); lines.push(...a.filter(Boolean)); });
    return { stop: () => { try { p.kill(); } catch {} return lines; } };
  } catch { return { stop: () => [] }; } }
// kit v2 (30/10) : coût CPU du trajet. Temps CPU cumulé de chaque processus Chrome (SystemInfo.getProcessInfo, cible
// navigateur : browser, renderer, GPU, utility…) et du fil principal de la page (Performance.getMetrics : TaskDuration,
// ScriptDuration), relevés avant et après CHAQUE tronçon du trajet : les captures entre tronçons ne comptent pas.
// Résultat en ms de CPU par seconde de trajet (1 000 = un cœur plein). Best effort : un relevé raté ⟹ out.cpu absent.
const devtoolsPort = (() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\s+/)[0]; } catch { return null; } })();
let bws = null, bid = 1; const bpend = new Map();
async function browserSend(method, params = {}) {
  if (!bws) {
    const v = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
    bws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((a, b) => { bws.onopen = a; bws.onerror = b; });
    bws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m); bpend.delete(m.id); } };
  }
  return new Promise((ok) => { const i = bid++; bpend.set(i, ok); bws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (bpend.has(i)) { bpend.delete(i); ok({ error: "délai" }); } }, 10000); });
}
async function cpuSnap() {
  try {
    const [pi, pm] = await Promise.all([browserSend("SystemInfo.getProcessInfo"), send("Performance.getMetrics")]);
    if (!pi.result?.processInfo) return null;
    const by = {};
    for (const p of pi.result.processInfo) { const t = String(p.type ?? "autre").toLowerCase(); by[t] = (by[t] ?? 0) + (Number(p.cpuTime) || 0); }
    const mt = Object.fromEntries((pm.result?.metrics ?? []).map((m) => [m.name, m.value]));
    return { t: Date.now(), by, task: mt.TaskDuration ?? null, script: mt.ScriptDuration ?? null };
  } catch { return null; }
}
const cpuAccNew = () => ({ wallMs: 0, by: {}, task: 0, script: 0, segs: 0, missed: 0 });
const cpuAcc = cpuAccNew(), cpuIdleAcc = cpuAccNew(); // trajet ; repos caméra immobile (P.idle)
function cpuAdd(a, b, cpuAcc) {
  if (!a || !b) { cpuAcc.missed++; return; }
  cpuAcc.wallMs += b.t - a.t; cpuAcc.segs++;
  // Un processus disparu entre deux relevés ferait baisser la somme de son type : jamais de delta négatif.
  for (const t of new Set([...Object.keys(a.by), ...Object.keys(b.by)])) cpuAcc.by[t] = (cpuAcc.by[t] ?? 0) + Math.max(0, (b.by[t] ?? 0) - (a.by[t] ?? 0));
  if (a.task != null && b.task != null) cpuAcc.task += Math.max(0, b.task - a.task);
  if (a.script != null && b.script != null) cpuAcc.script += Math.max(0, b.script - a.script);
}
function cpuSummary(cpuAcc) {
  if (!cpuAcc.segs || cpuAcc.wallMs <= 0) return null;
  const perSec = (s) => Math.round((s * 1000 * 1000) / cpuAcc.wallMs * 10) / 10; // s de CPU ⟹ ms de CPU par s de trajet
  const msPerSec = Object.fromEntries(Object.entries(cpuAcc.by).map(([t, s]) => [t, perSec(s)]));
  return { vsync: VSYNC, wallMs: cpuAcc.wallMs, segments: cpuAcc.segs, missed: cpuAcc.missed, msPerSec, totalMsPerSec: perSec(Object.values(cpuAcc.by).reduce((x, y) => x + y, 0)),
    mainThread: { taskMsPerSec: perSec(cpuAcc.task), scriptMsPerSec: perSec(cpuAcc.script) }, cores: cpus().length, cpuModel: cpus()[0]?.model ?? null };
}
// Perte vue dans le pane (device, contexte WebGL) ou onglet planté ; une lecture impossible n'est pas une perte.
const readLost = async () => { if (crashed) return crashed; try { return (await inPane(`return P ? P.lost() : null;`, 10000)) ?? null; } catch { return crashed; } };
const stopIfLost = async (phase) => { const l = await readLost(); if (!l) return false; out.lost = `${phase} : ${l}`; console.log("PERTE :", out.lost, "— arrêt"); write(); process.exitCode = 3; return true; };

try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Inspector.enable"); await send("Performance.enable").catch(() => {});
  for (const source of [COUNTER, GPUTIMER, WEBGPU_TIMER_SOURCE, PROBE_SOURCE]) await send("Page.addScriptToEvaluateOnNewDocument", { source });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/site/solo.html?tool=${args.tool}&model=${args.model}&form=${args.form}&autoload=1${args.qs ? "&" + args.qs : ""}` });
  let status = "";
  const loadT0 = Date.now();
  while (Date.now() - loadT0 < LOAD_TIMEOUT_MS && !crashed) { await sleep(500); status = (await ev(`document.getElementById("status").textContent`)) ?? ""; if (/done|failed/.test(status)) break; if ((await readLost())) break; }
  // Important 9 : ni done ni failed dans le délai (le même que view.mjs) ⟹ « délai dépassé ».
  const timedOut = !/done|failed/.test(status) && !crashed && Date.now() - loadT0 >= LOAD_TIMEOUT_MS;
  out.status = (timedOut ? `délai dépassé (${LOAD_TIMEOUT_MS / 1000} s) : ` : "") + status.split("\n")[0].slice(0, 240);
  console.log(out.status);
  if (!/done/.test(status)) {
    if (await stopIfLost("chargement")) throw new Error(out.lost);
    out.flags.gpuUnmeasured = true; out.flags.reason = timedOut ? "délai dépassé" : "chargement non terminé"; write(); process.exitCode = 2; throw new Error(out.flags.reason);
  }
  // local (rebench, 26/10) : le travail d'après done (propriétés d'ifc-lite, métadonnées) finit avant le repos et le trajet.
  while (Date.now() - loadT0 < LOAD_TIMEOUT_MS && !crashed) { const c = await inPane(`return w.__benchExtra ? w.__benchExtra.complete !== false : true;`).catch(() => true); if (c) break; await sleep(250); }
  await inPane(`if (!P || !w.__benchCamera) throw new Error("crochets ou caméra absents du pane"); return w.eval(${JSON.stringify(DRIVER_SOURCE)});`);
  // Même trajet partout : sans boîte, setAt ne ferait rien en silence.
  const box = await inPane(`return w.__benchCamera.box();`);
  if (!box || !box.min || !box.max) throw new Error("__benchCamera.box() est null : trajet impossible");
  // local (#671, coupes) : PANE_SETUP_JS = corps de fonction exécuté dans le pane (w = fenêtre du pane) après le chargement,
  // avant le repos et le trajet (ex. poser une boîte de coupe) ; le résultat est recopié dans out.setup.
  if (process.env.PANE_SETUP_JS) { out.setup = await inPane(process.env.PANE_SETUP_JS); console.log("setup :", JSON.stringify(out.setup)); }

  // Même taille de canvas pour tous les panes (deux passes : la barre de statut du pane peut se replier).
  await inPane(`await w.__benchCamera.pose("iso"); return 1;`);
  await sleep(REST_IDLE_MS);
  if (await stopIfLost("repos (attente)")) throw new Error(out.lost);
  await inPane(`return P.resetHooks();`); // important 4 : rien du chargement ne reste dans les crochets
  const cpuIdle0 = await cpuSnap();
  const idleMs = await inPane(`return await P.idle(${REST_MS}, ${TAG_IDLE});`);
  cpuAdd(cpuIdle0, await cpuSnap(), cpuIdleAcc); out.cpuIdle = cpuSummary(cpuIdleAcc); // kit v2 : CPU caméra immobile
  if (process.env.MICRO_DEG) await inPane(`w.__probeMicroDeg = ${Number(process.env.MICRO_DEG)}; return 1;`); // diagnostic : amplitude du micro-pas
  const restRows = await inPane(`return await P.rest(${STATIC_FRAMES}, ${TAG_REST}, ${JSON.stringify(VIEWPOINTS.iso)});`);
  if (await stopIfLost("repos")) throw new Error(out.lost);

  // Trajet, en tronçons s'il y a des captures en mouvement.
  const cuts = args.shots ? [...MOVING_SHOTS, PATH_MS] : [PATH_MS];
  const smi = startSmi(); const pathWall0 = Date.now();
  try {
    for (const c of cuts) {
      const cpu0 = await cpuSnap();
      await inPane(`return await P.pathSegment(${c}, ${TAG_PATH});`, PATH_EVAL_TIMEOUT_MS); // C1 : 1 201 pas imposés, un viewer lent dépasse 60 s
      cpuAdd(cpu0, await cpuSnap(), cpuAcc);
      if (c !== PATH_MS) await shot(`move-${String(c / 1000).padStart(2, "0")}s`);
      if (await stopIfLost(`trajet (t ≤ ${c} ms)`)) throw new Error(out.lost);
    }
  } finally { out.smi = smiSummary(smi.stop()); out.pathWallMs = Date.now() - pathWall0; out.cpu = cpuSummary(cpuAcc); }
  const pathRows = await inPane(`return P.pathRows;`);
  const pathRaf = await inPane(`return P.pathRaf;`);

  // Les 11 instants du trajet, 600 ms chacun ; caméra réellement rendue relevée à chacun.
  const vpRows = [], vpCam = [];
  for (let i = 0; i < INSTANTS.length; i++) {
    vpRows.push(await inPane(`return await P.viewpoint(${INSTANTS[i]}, ${VIEW_MS}, ${TAG_VIEW0 + i});`));
    vpCam.push(await inPane(`return P.camState();`));
    await shot(`t${String(INSTANTS[i] / 1000).padStart(2, "0")}s`);
    if (await stopIfLost(`point de vue t=${INSTANTS[i]} ms`)) throw new Error(out.lost);
  }
  await inPane(`await P.drainAll([${ALL_TAGS.join(",")}]); return 1;`);
  const info = await inPane(`return P.info();`);
  const keyed = await inPane(`return P.keyed([${ALL_TAGS.join(",")}]);`);
  // Contrôle du boost par les compteurs de culling GPU (Scenoptic WebGPU), après les mesures.
  const boostPass = await inPane(`return await P.boostPass(${JSON.stringify(INSTANTS)}, ${VIEW_MS}, ${PATH_MS});`, 180000);
  if (await stopIfLost("passe de contrôle du boost")) throw new Error(out.lost);
  out.info = info;

  // Version : branche@sha du statut (Scenoptic), sinon version déclarée par le pane (That Open).
  out.version = out.status.match(/[\w./-]+@[0-9a-f]{7,}\S*/)?.[0] ?? info.extra?.toc?.version ?? info.tocLive?.version ?? null;
  // Backend : déclaré par le pane (extra.rebench.backend, extra.toc.renderer) ; sinon WebGPU si des passes sont vues, WebGL si un contexte est sondé.
  const declared = info.extra?.rebench?.backend ?? info.rebenchLive?.backend ?? info.extra?.toc?.renderer ?? null;
  const devices = info.gpuW?.devices ?? [];
  const seen = info.gpuW?.counts?.passes > 0 ? "webgpu" : info.gl.length ? "webgl" : devices.length ? "webgpu" : null;
  out.backend = declared === "webgpu" || declared === "webgl" ? declared : seen;
  out.backendSeen = seen;
  if (declared && declared !== "webgpu" && declared !== "webgl") { out.flags.gpuUnmeasured = true; out.flags.reason = `rendu déclaré « ${declared} »`; }
  out.adapter = info.extra?.viewerAdapter ?? info.extra?.toc?.adapter ?? devices.find((d) => d.adapter)?.adapter ?? info.gl.find((g) => g.renderer)?.renderer ?? null;
  // C1 : nvidia-smi relève la carte NVIDIA même quand le viewer tourne sur l'iGPU : relevé marqué non pertinent alors.
  if (out.smi) out.smi.relevant = /nvidia/i.test(typeof out.adapter === "string" ? out.adapter : JSON.stringify(out.adapter ?? ""));

  const gpuWeb = out.backend === "webgpu";
  const src = gpuWeb ? keyed.gpuW : keyed.gl;
  const ms = (tag) => (src[tag] ?? []).map((x) => x.ms);
  // Triangles par pas : compteur WebGL, ou statistiques du viewer, ou estimation WebGPU (draws directs).
  const hasViewerTris = restRows.some((r) => r.tris.viewer != null);
  const triOf = (r) => (out.backend === "webgl" ? r.tris.gl : r.tris.viewer ?? (r.tris.wgpuIndirect ? null : r.tris.wgpu));
  out.trisSource = out.backend === "webgl" ? "COUNTER (WebGL, toutes passes)" : hasViewerTris ? "viewer.renderBackend.getDebugStats().triangles (total chargé)" : "draw/drawIndexed WebGPU (estimation, indirects exclus)";
  const nz = (a) => a.filter((x) => x != null && x > 0);

  // Important 8 : draws WebGL faits hors callback rAF (invisibles au timer query de GPUTIMER), sur la fenêtre mesurée.
  const glRaf = info.glRaf; out.glOutsideRaf = glRaf ? { ...glRaf, frac: glRaf.draws ? r3(glRaf.outside / glRaf.draws) : 0 } : null;
  if (!out.flags.gpuUnmeasured) {
    if (out.backend === "webgl" && glRaf && glRaf.draws > 0 && glRaf.outside / glRaf.draws > 0.05) { out.flags.gpuUnmeasured = true; out.flags.reason = `draws WebGL hors rAF : ${glRaf.outside}/${glRaf.draws}`; }
    else if (!out.backend) { out.flags.gpuUnmeasured = true; out.flags.reason = "ni device WebGPU ni contexte WebGL2 avec EXT_disjoint_timer_query_webgl2"; }
    else if (gpuWeb && info.gpuW?.unreliable) { out.flags.gpuUnmeasured = true; out.flags.reason = `__gpuW.unreliable : ${info.gpuW.counts.outsideRaf}/${info.gpuW.counts.passes} passes hors rAF`; }
    else if (gpuWeb && devices.length > 0 && info.gpuW.spans === 0) { out.flags.gpuUnmeasured = true; out.flags.reason = "device WebGPU mais 0 span (passes encodées dans un worker ?)"; }
    else if (gpuWeb && devices.length > 0 && !devices.some((d) => d.ts)) { out.flags.gpuUnmeasured = true; out.flags.reason = "device sans timestamp-query"; }
    else if (!ms(TAG_PATH).length) { out.flags.gpuUnmeasured = true; out.flags.reason = `aucune durée GPU sur le trajet (${out.backend})`; }
  }
  out.flags.tsQuantized = gpuWeb ? !!info.gpuW?.quantized : false;
  // Passes horodatées par le viewer avec un seul index et restées sans partenaire : leur temps manque au total.
  out.flags.partialTiming = gpuWeb && (info.gpuW?.counts?.foreignUnpaired ?? 0) > 0;
  const gpuOk = !out.flags.gpuUnmeasured;

  // Repos : (1) travail GPU par seconde sans rendu forcé, (2) coût d'UNE image forcée à pose fixe (première image après chaque pas).
  const staticPer = perStepFrames(restRows.map((r) => (gpuWeb ? r.frameKey : r.rafKey)), src[TAG_REST] ?? []).filter((x) => x != null);
  out.rest = { idleGpuMsPerSec: gpuOk ? r3(gpuMsPerSecond(ms(TAG_IDLE), idleMs)) : null, idleFramesPerSec: r3(ms(TAG_IDLE).length / (idleMs / 1000)), idleMs: Math.round(idleMs),
    staticFrameMs: gpuOk ? r3(med(staticPer)) : null, staticFrames: staticPer.length, staticSteps: restRows.length, staticAllFrames: ms(TAG_REST).length, tris: med(nz(restRows.map(triOf))), sample: staticPer.map(r3), allSample: ms(TAG_REST).slice(0, 60).map(r3) };
  // Une image par pas (première image avec travail après le début du pas).
  const perStep = perStepFrames(pathRows.map((r) => (gpuWeb ? r.frameKey : r.rafKey)), src[TAG_PATH] ?? []);
  const got = perStep.filter((x) => x != null);
  const ps = pathSummary(got), all = pathSummary(ms(TAG_PATH));
  const rafAll = pathRaf.flatMap((seg) => diffs(seg));
  out.path = { gpuMsMed: gpuOk ? r3(ps.med) : null, gpuMsP95: gpuOk ? r3(ps.p95) : null, gpuMsP99: gpuOk ? r3(ps.p99) : null,
    frames: got.length, steps: pathRows.length, stepsWithoutFrame: perStep.length - got.length,
    tris: med(nz(pathRows.map(triOf))), framesOver100ms: gpuOk ? ps.over100 : 0, over100Frac: gpuOk && got.length ? r3(ps.over100 / got.length) : 0,
    // Compléments, jamais « CPU » : latence d'un pas (début → rAF de la sonde), intervalle entre pas, intervalle entre rAF.
    stepLatencyMsMed: r3(med(pathRows.map((r) => r.lat))), stepIntervalMsMed: r3(med(diffs(pathRows.map((r) => r.ts)))), gpuWaitMsMed: r3(med(pathRows.map((r) => r.wait))), waitPollsMed: med(pathRows.map((r) => r.polls ?? 0)), gpuCutFrac: r3(pathRows.filter((r) => r.gpuCut).length / Math.max(1, pathRows.length)), // 26/10 : pas dont l'image GPU n'était pas finie à l'échéance
    rafIntervalMsMed: r3(med(rafAll)),
    sample: got.slice(0, 30).map(r3) };
  // C1 : cadence imposée (un pas toutes les 1000 / STEP_HZ ms d'horloge) et ses dépassements.
  const durs = pathRows.map((r) => r.dur).filter((x) => x != null), dsum = pathSummary(durs);
  out.cadence = { stepHz: STEP_HZ, stepMs: r3(1000 / STEP_HZ), steps: pathRows.length, overruns: pathRows.filter((r) => r.over).length, overrunFrac: pathRows.length ? r3(pathRows.filter((r) => r.over).length / pathRows.length) : null, stepWallMsMed: r3(dsum.med), stepWallMsP95: r3(dsum.p95), pathWallMs: out.pathWallMs };
  // Toutes les images GPU taguées trajet (images à la même pose comprises) : champ secondaire, pondération propre au viewer.
  out.pathAllFrames = { frames: ms(TAG_PATH).length, gpuMsMed: gpuOk ? r3(all.med) : null, gpuMsP95: gpuOk ? r3(all.p95) : null, gpuMsP99: gpuOk ? r3(all.p99) : null, over100: gpuOk ? all.over100 : 0 };
  // #865 (29/10) : MOYENNE de toutes les images du trajet = coût par image fiable quand les images diffèrent (culling une
  // image sur N, images tenues) ; la médiane « une image par pas » ne voit alors qu'une parité. perStepUnreliable : la
  // médiane par pas s'écarte de plus de 10 % de cette moyenne ⟹ ne pas publier path.gpuMsMed, utiliser gpuMsMean.
  { const a = ms(TAG_PATH); const mean = a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    out.pathAllFrames.gpuMsMean = gpuOk && mean != null ? r3(mean) : null;
    out.pathAllFrames.framesPerStep = pathRows.length ? r3(a.length / pathRows.length) : null;
    out.flags.perStepUnreliable = !!(gpuOk && mean && out.path.gpuMsMed != null && Math.abs(out.path.gpuMsMed - mean) / mean > 0.1); }
  // Points de vue : triangles = médiane de la seconde moitié des images (repos atteint), GPU = médiane de l'étiquette (pose fixe).
  out.viewpoints = INSTANTS.map((t, i) => { const rows = vpRows[i] ?? []; const tail = rows.slice(rows.length >> 1);
    return { name: `t${String(t / 1000).padStart(2, "0")}s`, t, gpuMs: gpuOk ? r3(med(ms(TAG_VIEW0 + i))) : null, tris: med(nz(tail.map(triOf))), frames: rows.length }; });

  // Contrôle du boost : capteur par image, paires aux 11 instants. Revue finale C2 : la grille de poses est commune au trajet
  // et aux instants (k × 1000 / STEP_HZ ms), donc la paire est la MÊME pose (écart relevé dans boostPairsDtMs, tolérance 1 ms).
  const nearestRow = (rows, t) => { let best = null; for (const r of rows) if (Math.abs(r.t - t) <= PAIR_TOL_MS && (!best || Math.abs(r.t - t) < Math.abs(best.t - t))) best = r; return best; };
  const nearest = (rows, t, get) => { const b = nearestRow(rows, t); const x = b ? get(b) : null; return x > 0 ? x : null; };
  let restT, moveT, perFrame, sensor, moveRows;
  if (boostPass) { sensor = "readGpuDrawCounters (triangles + clusterTriangles), passe non mesurée, image en régime au repos"; perFrame = true; moveRows = boostPass.move;
    restT = boostPass.rest.map((x) => (x > 0 ? x : null)); moveT = INSTANTS.map((t) => nearest(boostPass.move, t, (r) => r.tris)); out.boostPassSteps = boostPass.move.length;
    // Diagnostic C2 : ce que donnait l'ancienne lecture (copie latente = image du saut de pose) et le détail instances / grappes.
    out.boostPassDiag = { restJump: boostPass.restJump, restDetail: boostPass.restDetail, moveDetail: INSTANTS.map((t) => { const b = nearestRow(boostPass.move, t); return b ? { inst: b.inst, cl: b.cl } : null; }),
      jumpRatios: boostRatios(boostPass.restJump, moveT).map(r3) }; }
  else { sensor = out.trisSource; perFrame = out.backend === "webgl" || !hasViewerTris; moveRows = pathRows;
    restT = out.viewpoints.map((vp) => vp.tris); moveT = INSTANTS.map((t) => nearest(pathRows, t, triOf)); }
  const verdict = boostVerdict(restT, moveT, perFrame);
  out.boostPairs = restT.map((r, i) => [r, moveT[i]]);
  out.boostPairsDtMs = INSTANTS.map((t) => { const b = nearestRow(moveRows, t); return b ? r3(b.t - t) : null; });
  out.boostRatios = boostRatios(restT, moveT).map(r3);
  out.flags.boostChecked = verdict.checked; out.flags.boostSuspect = verdict.suspect;
  out.flags.boostCheck = { sensor, pairs: verdict.pairs, reason: verdict.reason, restVaries: new Set(restT.filter((x) => x != null)).size > 1, criterion: "médiane des rapports < 0,9 ou une pose < 0,7" };

  // Caméra : boîte du trajet, poses voulues (toWorld) et caméra réellement rendue aux 11 instants, canvas.
  const up = vpCam.find((c) => c)?.up ?? null;
  const R = (x) => Math.round(x * 1000) / 1000;
  out.camera = { box: { min: box.min.map(R), max: box.max.map(R) }, up, fov: vpCam.find((c) => c)?.fov ?? null, aspect: vpCam.find((c) => c)?.aspect ?? null,
    canvas: info.canvas.main, canvasTarget: [CANVAS_W, CANVAS_H], canvasDeltaPx: info.canvas.main ? [info.canvas.main.cw - CANVAS_W, info.canvas.main.ch - CANVAS_H] : null, canvasOk: !!info.canvas.main && info.canvas.main.cw === CANVAS_W && info.canvas.main.ch === CANVAS_H && info.canvas.main.w === info.canvas.main.cw && info.canvas.main.h === info.canvas.main.ch,
    poses: INSTANTS.map((t, i) => { const want = up ? toWorld(poseAt(t), box, up) : null; return { t, eye: want ? want.eye.map(R) : null, target: want ? want.target.map(R) : null, rendered: vpCam[i] ?? null }; }) };
  // Anticrénelage (libre) : attributs des contextes WebGL, textures multi-échantillonnées et passes avec resolveTarget en WebGPU.
  out.aa = { webgl: info.gl.map((g) => ({ antialias: g.antialias, samples: g.samples, size: [g.w, g.h] })), webgpu: info.devs ? info.msaa : null };
  out.rebench = info.rebenchLive ?? info.extra?.rebench ?? null;
  out.gpuWCounts = info.gpuW?.counts ?? null;
  out.partialByLabel = info.partialByLabel;
  out.passLabels = info.passLabels; // important 7 : anticrénelage dérivé des passes réellement encodées (WebGPU)
  if (await stopIfLost("fin")) throw new Error(out.lost);
  write();
  console.log(JSON.stringify({ others: [benchContext.othersAtStart?.length ?? null, benchContext.othersAtEnd?.length ?? null], lockFree: benchContext.lockFreeAtStart, backend: out.backend, adapter: out.adapter, version: out.version, conversion: out.conversion, rest: { ...out.rest, sample: undefined, allSample: undefined }, path: { ...out.path, sample: undefined }, cadence: out.cadence, smi: out.smi, pathAllFrames: out.pathAllFrames, flags: out.flags, boostRatios: out.boostRatios, glOutsideRaf: out.glOutsideRaf, canvas: out.camera.canvas, lost: out.lost, boostReapplied: out.rebench?.boostReapplied ?? null }));
} catch (e) {
  if (crashed && !out.lost) { out.lost = crashed; process.exitCode = 3; }
  if (!process.exitCode) process.exitCode = 1;
  out.error = String(e?.message ?? e).slice(0, 500); write();
  console.log("erreur :", out.error);
} finally {
  benchContext.othersAtEnd = otherBenchChromes(profile);
  if (benchContext.othersAtEnd?.length) benchContext.contended = true;
  try { ws.close(); } catch {} try { bws?.close(); } catch {} spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); server.close();
  try { write(); } catch {}
  releaseLock();
}
