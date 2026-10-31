// Pane for IFClite (@ifc-lite/renderer + @ifc-lite/geometry), bundled by Vite
// into dist/pane.js. The calls follow the packages' READMEs. See README.md here.
import { Renderer } from "@ifc-lite/renderer";
import { GeometryProcessor, decodeInstancedShard } from "@ifc-lite/geometry";
import { GEOM_CLASS_INSTANCED_TYPE, GEOM_CLASS_ORPHAN_TYPE, geometryClassOf } from "@ifc-lite/geometry/geometry-class";
import { IfcParser } from "@ifc-lite/parser";
import { WorkerParser } from "@ifc-lite/parser/browser";
import { createPane } from "../pane.mjs";
import { installCameraPath } from "../camera-path.mjs";
import { computeFullSourceHash, decideMeshOnlyCacheHit, deleteCached, geometryCacheKey, getCached, openCachedEntry, planCache, saveCacheEntry } from "./ifc-cache.mjs"; // local (rebench, 26/10)

const canvas = document.getElementById("view");
const version = __IFCLITE_VERSIONS__; // set by vite.config.js from the installed packages
let gpu; // { renderer, geometry }, made on the first load and reused
let run = 0; // a second load message supersedes the first

function size() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}

// local (trajet 2) : les éléments répétés (gabarits IFC) n'arrivent pas dans event.meshes mais à part, dans
// event.instancedShards (et dans la section InstancedShards du cache) ; leur viewer les passe à
// scene.addInstancedShard(device, decodeInstancedShard(shard), modelIndex). Le pane d'origine ne lisait que les meshes :
// ces éléments manquaient à l'écran et au compte des triangles. Placement : transform (ligne par ligne, repère IFC Z-up)
// appliquée au gabarit, puis passage Z-up → Y-up du renderer ; un décalage d'assemblage (Y-up) s'ajoute donc en Z-up
// comme (x, -z, y) à la translation (éléments 3, 7, 11).
let instancedTriangles = 0, instancedOccurrences = 0;
function addShards(renderer, shards, modelIndex, off) {
  if (!shards?.length) return;
  const device = renderer.getGPUDevice(), scene = renderer.getScene();
  if (!device || !scene?.addInstancedShard) return;
  const shift = off && off.some((x) => x !== 0) ? [off[0], -off[2], off[1]] : null;
  for (const raw of shards) {
    const shard = decodeInstancedShard(raw);
    if (shift) for (const it of shard.instances) { it.transform[3] += shift[0]; it.transform[7] += shift[1]; it.transform[11] += shift[2]; }
    scene.addInstancedShard(device, shard, modelIndex);
    instancedOccurrences += shard.instances.length;
    for (const it of shard.instances) instancedTriangles += (shard.templates[it.templateIndex]?.indices.length ?? 0) / 3;
  }
}

// Orbit with the left button, pan with the right, zoom with the wheel.
function wireControls(renderer) {
  const camera = renderer.getCamera();
  let drag;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { drag = undefined; });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) camera.pan(dx, dy); else camera.orbit(dx, dy);
    renderer.requestRender();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoom(e.deltaY, false, e.offsetX, e.offsetY, canvas.clientWidth, canvas.clientHeight);
    renderer.requestRender();
  }, { passive: false });
  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(Math.floor(canvas.clientWidth * dpr), Math.floor(canvas.clientHeight * dpr));
    renderer.requestRender();
  }).observe(canvas);
}

// local (rebench, 26/10) : le renderer et le GeometryProcessor s'initialisent séparément, pour qu'une ouverture servie
// par le cache (forme ifc-cache) n'attende pas le WASM de géométrie, comme leur viewer qui ne crée son GeometryProcessor
// qu'après un défaut de cache (useIfcLoader.ts:1311). La forme ifc garde l'ordre d'avant : les deux en parallèle.
let rendererInit, geometryInit;
function ensureRenderer() {
  return (rendererInit ??= (async () => {
    size();
    const renderer = new Renderer(canvas);
    await renderer.init();
    // local (trajet 2) : vue « Modèle » de leur viewer (apps/viewer/src/lib/type-view-visibility.ts, isMeshVisibleInViewMode,
    // et TYPE_VISIBILITY_SEMANTIC_DEFAULTS de store/constants.ts). Le moteur émet aussi la bibliothèque de types
    // (geometryClass 2 = type instancié, jamais montré ; 1 = type orphelin, caché dès qu'il y a des occurrences), dessinée
    // dans son repère local : c'étaient les objets flottants à côté du bâtiment. Leur viewer cache aussi par défaut
    // espaces, zones, réservations et éléments virtuels. Relevé par objet gardé dans window.__ifcliteMeshes.
    const HIDDEN_BY_DEFAULT = new Set(["IfcSpace", "IfcSpatialZone", "IfcOpeningElement", "IfcVirtualElement"]);
    const modelView = (m) => { const c = geometryClassOf(m); return c !== GEOM_CLASS_INSTANCED_TYPE && c !== GEOM_CLASS_ORPHAN_TYPE && !HIDDEN_BY_DEFAULT.has(m.ifcType); };
    { const add = renderer.addMeshes.bind(renderer), rec = (window.__ifcliteMeshes = []), dropped = (window.__ifcliteDropped = {});
      renderer.addMeshes = (all, ...rest) => { const meshes = all.filter((m) => modelView(m) || ((dropped[m.ifcType] = (dropped[m.ifcType] || 0) + 1), false)); for (const m of meshes) { const p = m.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        rec.push({ id: m.expressId, type: m.ifcType, lo, hi }); } return add(meshes, ...rest); }; }
    wireControls(renderer);
    // The package leaves the frame loop to the host: requestRender() only sets a flag
    // (peekRenderRequest / consumeRenderRequest), and render() draws one frame.
    const loop = () => {
      if (renderer.consumeRenderRequest()) {
        renderer.render();
        for (const resolve of waiting.splice(0)) resolve();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    gpu = { ...gpu, renderer };
    window.__ifclite = gpu; // for check.mjs and debugging
    return renderer;
  })());
}
function ensureGeometry() {
  return (geometryInit ??= (async () => {
    const geometry = new GeometryProcessor();
    await geometry.init();
    gpu = { ...gpu, geometry };
    window.__ifclite = gpu;
    return geometry;
  })());
}
async function ensureGpu() {
  const [renderer, geometry] = await Promise.all([ensureRenderer(), ensureGeometry()]);
  return { renderer, geometry };
}

// local (rebench) : les propriétés, comme le viewer ifc-lite les charge (apps/viewer/src/hooks/useIfcLoader.ts,
// entityIndexHandoff.ts, clone du 06/09) : le modèle de données part en parallèle de la géométrie, dans un
// WorkerParser qui lit la même SharedArrayBuffer ; repli IfcParser.parseColumnar dans la page. Au-delà de 2 Mo
// le parseur attend l'index d'entités de la pré-passe géométrie (onEntityIndex) ; au-delà de 32 Mo l'index n'est
// relâché qu'à la fin d'un worker de géométrie (workerMemory / complete), borné à min(10 s, max(1 s, 8 ms/Mo)).
// Le parseur rend l'index, les relations et la table élément → jeux de propriétés (onDemandPropertyMap) ; les
// valeurs se décodent au clic, comme dans leur viewer. propsReadyMs = fin de parseColumnar, depuis le début du load.
function startProperties(bytes, geometry, t0) {
  const useWorker = WorkerParser.isSupported();
  const fileSizeMB = bytes.byteLength / (1024 * 1024);
  let sab = null;
  if (useWorker) { sab = new SharedArrayBuffer(bytes.byteLength); new Uint8Array(sab).set(bytes); }
  let workerParser = null;
  const deferUntilWorkerFinishes = useWorker && fileSizeMB >= 32;
  let ready = !deferUntilWorkerFinishes, pending, timer;
  const handoff = (...args) => { if (!ready) { pending = args; return; } workerParser?.setEntityIndex(...args); };
  handoff.release = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    ready = true;
    const args = pending; pending = undefined;
    if (args) handoff(...args);
  };
  if (deferUntilWorkerFinishes) timer = setTimeout(handoff.release, Math.min(10_000, Math.max(1_000, fileSizeMB * 8)));
  let sourceFingerprint;
  if (useWorker) { sourceFingerprint = new SharedArrayBuffer(16); const w = new Uint32Array(sourceFingerprint); w[0] = sab.byteLength >>> 0; w[1] = Math.floor(sab.byteLength / 0x100000000); }
  const at = { spatialMs: null };
  const onSpatialReady = () => { at.spatialMs ??= Math.round(performance.now() - t0); };
  const mainThread = () => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { wasmApi: geometry.getApi?.() ?? undefined, onSpatialReady });
  let path = useWorker ? "worker" : "main-thread";
  const parsed = new Promise((resolve) => setTimeout(resolve, 0)) // leur viewer : setTimeout(startDataModelParsing, 0)
    .then(() => {
      if (!useWorker) return mainThread();
      workerParser = new WorkerParser();
      return workerParser.parseColumnar(sab, { sourceFingerprint, onSpatialReady, waitForEntityIndex: fileSizeMB >= 2 })
        .catch((e) => { console.warn("ifc-lite parser worker failed, main-thread parse:", e); path = "main-thread (repli)"; return mainThread(); });
    });
  parsed.catch(() => {}); // local (rebench, 26/10) : `store` est lu par l'écriture du cache, l'échec est rapporté par `done`
  const done = parsed
    .then((store) => ({
      ok: true, path, propsReadyMs: Math.round(performance.now() - t0), spatialReadyMs: at.spatialMs,
      entities: store.entities?.count ?? null, elementsWithPsets: store.onDemandPropertyMap?.size ?? null,
    }), (e) => ({ ok: false, path, message: String(e?.message ?? e), propsReadyMs: null }));
  const view = sab ? new Uint8Array(sab) : bytes;
  return { done, store: parsed, view, adaptive: { existingSab: sab ?? undefined, sourceFingerprint, onEntityIndex: handoff }, release: handoff.release };
}

// local (rebench) : extra commun du banc, complete = false tant que les propriétés ne sont pas prêtes.
// local (rebench, 26/10) : `after` = travail de fond à attendre avant complete (écriture du cache, revalidation).
async function publishProperties(extra, jobs, after = []) {
  const all = await Promise.all(jobs.map((j) => j.done));
  const failed = all.find((r) => !r.ok);
  if (failed) extra.propsError = failed.message;
  else extra.propsReadyMs = Math.max(...all.map((r) => r.propsReadyMs));
  extra.props = all;
  if (after.length) await Promise.allSettled(after);
  extra.complete = true;
}

const waiting = [];
// Resolves after the frame loop has drawn once more.
const drawn = (renderer) => new Promise((resolve) => { waiting.push(resolve); renderer.requestRender(); });

async function load({ url, urls = [url], offsets, report, form }) {
  // local (rebench, 26/10) : la forme ifc-cache passe par le cache de leur viewer ; la forme ifc reste à froid, sans cache.
  if (form === "ifc-cache") return loadCached({ urls, offsets, report });
  // local (#796): an assembly (several urls) goes to loadParts; one file loads as before.
  if (urls.length > 1) return loadParts({ urls, offsets, report });
  const mine = ++run;
  const t0 = performance.now(); // local (rebench) : même origine que les états du pane (start() → load)
  window.__benchExtra = undefined;
  try {
    report("fetching");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    report("parsing", { bytes: bytes.byteLength });
    const { renderer, geometry } = await ensureGpu();
    const props = startProperties(bytes, geometry, t0); // local (rebench)
    const extra = (window.__benchExtra = { complete: false });
    let first = true;
    for await (const event of geometry.processAdaptive(props.view, props.adaptive)) {
      if (mine !== run) return;
      if (event.type === "workerMemory" || event.type === "complete") props.release(); // local (rebench)
      if (event.type === "batch") addShards(renderer, event.instancedShards, 0, null); // local (trajet 2)
      if (event.type !== "batch" || event.meshes.length === 0) continue;
      const upload = renderer.addMeshes(event.meshes, true);
      if (upload && upload.ok === false) throw new Error(`GPU upload failed: ${upload.reason ?? "unknown"}`);
      if (first) {
        first = false;
        renderer.fitToView();
        await drawn(renderer);
        report("first-frame", { bytes: bytes.byteLength });
      }
    }
    if (mine !== run) return;
    if (first) throw new Error("the file produced no geometry");
    renderer.fitToView();
    await drawn(renderer);
    report("done", { bytes: bytes.byteLength });
    await publishProperties(extra, [props]); // local (rebench)
  } catch (e) {
    if (window.__benchExtra) window.__benchExtra.complete = true; // local (rebench)
    report("failed", { message: String(e?.message ?? e) });
  }
}

// local (#796): every file of an assembly in one scene, fetched together, then processed in
// series: GeometryProcessor keeps one coordinate handler and one wasm streaming lock, reset per
// processAdaptive, so two files cannot run through it at once. Federation as the package offers
// it: the first file is processed as a single file is, and its RTC frame (the rtcOffset event, or
// coordinateInfo.wasmRtcFrame on the small-file path) goes to every later file as
// sharedRtcOffset, so all files share one coordinate space. Meshes carry modelIndex = file index.
// The pane clears nothing between loads, for one file as for several (each load is a fresh page
// in the bench). first-frame: the first batch of the first file, framed with fitToView and drawn,
// as a single file is; done: every file added, fitToView (the bounds of all meshes) and one draw.
async function loadParts({ urls, offsets, report }) {
  const mine = ++run;
  const t0 = performance.now(); // local (rebench)
  window.__benchExtra = undefined;
  try {
    report("fetching");
    const files = await Promise.all(urls.map(async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
      return new Uint8Array(await res.arrayBuffer());
    }));
    const total = files.reduce((t, b) => t + b.byteLength, 0);
    report("parsing", { bytes: total });
    const { renderer, geometry } = await ensureGpu();
    let first = true;
    let shared; // the first file's RTC frame, IFC Z-up
    const jobs = []; // local (rebench) : un parseur de données par fichier, lancé avec la géométrie du fichier
    const extra = (window.__benchExtra = { complete: false });
    for (let k = 0; k < files.length; k++) {
      const props = startProperties(files[k], geometry, t0);
      jobs.push(props);
      const options = k === 0 ? { ...props.adaptive } : { ...props.adaptive, sharedRtcOffset: shared };
      for await (const event of geometry.processAdaptive(props.view, options)) {
        if (mine !== run) return;
        if (event.type === "workerMemory" || event.type === "complete") props.release(); // local (rebench)
        if (k === 0 && !shared) {
          if (event.type === "rtcOffset") shared = event.hasRtc ? { ...event.rtcOffset } : { x: 0, y: 0, z: 0 };
          const frame = event.coordinateInfo?.wasmRtcFrame;
          if (frame) shared = frame.needsShift ? { x: frame.x, y: frame.y, z: frame.z } : { x: 0, y: 0, z: 0 };
        }
        if (event.type === "batch") addShards(renderer, event.instancedShards, k, offsets?.[k]); // local (trajet 2)
        if (event.type !== "batch" || event.meshes.length === 0) continue;
        for (const m of event.meshes) m.modelIndex = k;
        // local : matrice d'assemblage, sommets décalés (monde Y-up du renderer) avant l'envoi au GPU.
        const off = offsets?.[k];
        if (off && off.some((x) => x !== 0)) for (const m of event.meshes) { const p = m.positions; for (let i = 0; i < p.length; i += 3) { p[i] += off[0]; p[i + 1] += off[1]; p[i + 2] += off[2]; } }
        const upload = renderer.addMeshes(event.meshes, true);
        if (upload && upload.ok === false) throw new Error(`GPU upload failed: ${upload.reason ?? "unknown"}`);
        if (first) {
          first = false;
          renderer.fitToView();
          await drawn(renderer);
          report("first-frame", { bytes: total });
        }
      }
      shared ??= { x: 0, y: 0, z: 0 };
    }
    if (mine !== run) return;
    if (first) throw new Error("the files produced no geometry");
    renderer.fitToView();
    await drawn(renderer);
    report("done", { bytes: total, models: files.length });
    await publishProperties(extra, jobs); // local (rebench)
  } catch (e) {
    if (window.__benchExtra) window.__benchExtra.complete = true; // local (rebench)
    report("failed", { message: String(e?.message ?? e) });
  }
}

// local (rebench, 26/10) : forme ifc-cache. Le cache IndexedDB du viewer ifc-lite (ifc-cache.mjs, règles et lignes
// de leur code en tête du module), branché comme leur loader le fait (apps/viewer/src/hooks/useIfcLoader.ts:1069-1243
// pour la lecture, :1973-2018 pour l'écriture) :
//   - le fichier est lu en entier, puis empreinte, clé, palier (taille) : rien < 10 Mio, « source » 10-150 Mio,
//     « mesh-only » 150-400 Mio, rien > 400 Mio ;
//   - servi : le modèle de données est réhydraté (tables, index d'entités, cartes à la demande, hiérarchie spatiale),
//     PUIS la géométrie arrive morceau par morceau (une tâche entre deux morceaux) ; pas de WASM de géométrie ; les
//     propriétés sont prêtes quand la géométrie est posée (leur setIfcDataStore suit la boucle des morceaux) ;
//   - défaut : le chemin WASM de la forme ifc, inchangé (géométrie + WorkerParser en parallèle), puis, la géométrie
//     finie et le modèle de données prêt, écriture en tâche de fond (leur finalizePromise) ; extra.complete attend
//     l'écriture ; cache[0].cacheWrittenMs = son instant depuis le début du chargement ;
//   - mesh-only servi : revalidation SHA-256 du fichier en tâche de fond (leur revalidateSourceDecoupledHit) ;
//   - fédération : le cache ne sert que le modèle PRINCIPAL (le 1er fichier) ; un modèle ajouté repasse par le WASM
//     sans cache (« Cache + server are PRIMARY-ONLY », useIfcLoader.ts:1134), avec le RTC du principal.
// lastModified : un fichier servi en HTTP n'a pas de date de modification fiable ; elle reste inconnue, et la règle de
// leur viewer sert alors l'entrée mesh-only sur la foi du SHA-256 revalidé en fond (decideMeshOnlyCacheHit).
const LAST_MODIFIED = undefined;
async function loadCached({ urls, offsets, report }) {
  const mine = ++run;
  const stale = () => mine !== run;
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const multi = urls.length > 1;
  window.__benchExtra = undefined;
  try {
    report("fetching");
    const files = await Promise.all(urls.map(async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
      return new Uint8Array(await res.arrayBuffer());
    }));
    const total = files.reduce((t, b) => t + b.byteLength, 0);
    report("parsing", { bytes: total });
    const rendererReady = ensureRenderer(); // leur renderer existe avant l'ouverture du fichier
    rendererReady.catch(() => {});
    const extra = (window.__benchExtra = { complete: false, cache: [] });
    const jobs = [], background = [];
    let first = true, shared, triangles = 0, uploadedMeshes = 0;
    const upload = async (renderer, meshes, k) => {
      if (multi) for (const m of meshes) m.modelIndex = k;
      const off = offsets?.[k];
      if (off && off.some((x) => x !== 0)) for (const m of meshes) { const p = m.positions; for (let i = 0; i < p.length; i += 3) { p[i] += off[0]; p[i + 1] += off[1]; p[i + 2] += off[2]; } }
      for (const m of meshes) triangles += (m.indices?.length ?? 0) / 3;
      uploadedMeshes += meshes.length;
      const up = renderer.addMeshes(meshes, true);
      if (up && up.ok === false) throw new Error(`GPU upload failed: ${up.reason ?? "unknown"}`);
      if (first) {
        first = false;
        renderer.fitToView();
        await drawn(renderer);
        report("first-frame", { bytes: total });
      }
    };
    const rtcOf = (c) => {
      const f = c?.wasmRtcFrame;
      if (f) return f.needsShift ? { x: f.x, y: f.y, z: f.z } : { x: 0, y: 0, z: 0 };
      return c?.wasmRtcOffset ? { ...c.wasmRtcOffset } : undefined;
    };
    for (let k = 0; k < files.length; k++) {
      const bytes = files[k];
      const info = { file: k, bytes: bytes.byteLength };
      extra.cache.push(info);
      const plan = k === 0 ? planCache(bytes.byteLength) : { tier: "none", shouldCache: false, persistSource: false, reason: "modèle ajouté (fédéré) : WASM sans cache, comme leur viewer" };
      Object.assign(info, { tier: plan.tier, hit: false, reason: plan.reason });
      let key, entry = null, cached = null;
      if (plan.shouldCache) {
        const tk = performance.now();
        ({ key } = geometryCacheKey(bytes));
        info.key = key;
        cached = await getCached(key);
        info.lookupMs = Math.round(performance.now() - tk);
        if (stale()) return;
        if (!cached) info.reason = `${plan.tier} : défaut (entrée absente), WASM puis écriture`;
        else {
          const decoupled = !cached.sourceBuffer;
          const mayServe = !decoupled || decideMeshOnlyCacheHit({ storedMtime: cached.lastModified, freshMtime: LAST_MODIFIED, hasFullHash: !!cached.fullSourceHash }) === "serve";
          if (!mayServe) { await deleteCached(key); info.reason = `${plan.tier} : entrée non validable, effacée, WASM puis écriture`; }
          else {
            const th = performance.now();
            try { entry = await openCachedEntry(cached, bytes.buffer); }
            catch (e) { console.error("[useIfcCache] Failed to load from cache:", e); await deleteCached(key); info.reason = `${plan.tier} : entrée illisible (${String(e?.message ?? e)}), effacée, WASM`; }
            info.hydrateMs = Math.round(performance.now() - th);
            if (stale()) return;
          }
        }
      }
      if (entry) {
        // Servi par le cache.
        Object.assign(info, { hit: true, reason: `${plan.tier} : servi par le cache (source ${entry.sourceFrom === "cache" ? "en cache" : "relue du fichier fourni"})`, cacheBytes: entry.cacheBytes, instancedShards: entry.shards.length });
        const renderer = await rendererReady;
        const open = entry.open;
        const tg = performance.now();
        if (open) for (let i = 0; i < open.chunks.length; i++) {
          const meshes = await open.readChunk(i);
          if (stale()) return;
          if (meshes.length) await upload(renderer, meshes, k);
          await new Promise((resolve) => setTimeout(resolve, 0)); // useIfcCache.ts:410
        }
        addShards(renderer, entry.shards, multi ? k : 0, offsets?.[k]); // local (trajet 2) : gabarits servis par le cache
        info.chunks = open?.chunks.length ?? 0;
        Object.assign(info, { cachedMeshes: open?.meshCount ?? null, cachedTriangles: open?.totalTriangles ?? null }); // contrôle : ce que le cache rend
        info.geometryMs = Math.round(performance.now() - tg);
        if (k === 0) shared = rtcOf(open?.coordinateInfo) ?? { x: 0, y: 0, z: 0 };
        const store = entry.dataStore;
        jobs.push({ done: Promise.resolve({ ok: true, path: `cache ${plan.tier}`, propsReadyMs: ms(), entities: store.entities?.count ?? null, elementsWithPsets: store.onDemandPropertyMap?.size ?? null }) });
        if (!cached.sourceBuffer && cached.fullSourceHash) {
          // Revalidation en fond du palier mesh-only (useIfcLoader.ts:270-305) : SHA-256 du fichier frais.
          background.push((async () => {
            const tr = performance.now();
            const hash = await computeFullSourceHash(bytes);
            const ok = hash == null || hash === cached.fullSourceHash;
            if (!ok) await deleteCached(key); // leur viewer recharge alors le fichier ; ici : signalé
            info.revalidate = { ok, ms: Math.round(performance.now() - tr) };
          })());
        }
        continue;
      }
      // Chemin WASM : celui de la forme ifc, avec la collecte de ce que leur viewer met en cache.
      const geometry = await ensureGeometry();
      const renderer = await rendererReady;
      const props = startProperties(bytes, geometry, t0);
      jobs.push(props);
      const keep = plan.shouldCache && !offsets?.[k]?.some((x) => x !== 0);
      const kept = { meshes: [], shards: [], coordinateInfo: null };
      const options = k === 0 ? { ...props.adaptive } : { ...props.adaptive, sharedRtcOffset: shared };
      for await (const event of geometry.processAdaptive(props.view, options)) {
        if (stale()) return;
        if (event.type === "workerMemory" || event.type === "complete") props.release();
        if (event.type === "complete") kept.coordinateInfo = event.coordinateInfo ?? null;
        if (k === 0 && !shared) {
          if (event.type === "rtcOffset") shared = event.hasRtc ? { ...event.rtcOffset } : { x: 0, y: 0, z: 0 };
          const frame = event.coordinateInfo?.wasmRtcFrame;
          if (frame) shared = frame.needsShift ? { x: frame.x, y: frame.y, z: frame.z } : { x: 0, y: 0, z: 0 };
        }
        if (event.type !== "batch") continue;
        if (event.instancedShards) { info.instancedShards = (info.instancedShards ?? 0) + event.instancedShards.length; if (keep) for (const sh of event.instancedShards) kept.shards.push(sh); addShards(renderer, event.instancedShards, multi ? k : 0, offsets?.[k]); } // local (trajet 2) : + affichage
        if (event.meshes.length === 0) continue;
        if (keep) for (const m of event.meshes) kept.meshes.push(m);
        await upload(renderer, event.meshes, k);
      }
      shared ??= { x: 0, y: 0, z: 0 };
      if (keep) {
        // Écriture en fond, une fois la géométrie finie et le modèle de données prêt (useIfcLoader.ts:1973-2018).
        background.push(props.store.then(async (store) => {
          if (stale()) return;
          const textured = kept.meshes.some((m) => m.texture || m.textureRef);
          if (textured) { info.write = { ok: false, why: "maquette texturée : leur viewer n'écrit pas (#1781)" }; return; }
          if (!kept.meshes.length || !kept.coordinateInfo) { info.write = { ok: false, why: "pas de géométrie ou de coordinateInfo final" }; return; }
          const geometryData = {
            meshes: kept.meshes,
            totalVertices: kept.meshes.reduce((t, m) => t + m.positions.length / 3, 0),
            totalTriangles: kept.meshes.reduce((t, m) => t + m.indices.length / 3, 0),
            coordinateInfo: kept.coordinateInfo,
            ...(kept.shards.length > 0 ? { instancedShards: kept.shards } : {}),
          };
          info.writeStartMs = ms();
          // Contrôle : ce qui part dans le cache, et ce que leur validateMeshes (@ifc-lite/cache, sections/geometry.js:9-33)
          // écartera : normales de longueur différente des positions (ou comptes déraisonnables).
          const dropped = kept.meshes.filter((m) => m.normals?.length !== m.positions.length);
          Object.assign(info, { keptMeshes: kept.meshes.length, keptTriangles: geometryData.totalTriangles, droppedByCacheMeshes: dropped.length, droppedByCacheTriangles: dropped.reduce((t, m) => t + m.indices.length / 3, 0), droppedNoNormals: dropped.filter((m) => !m.normals?.length).length });
          if (dropped.length) { const types = {}; for (const m of dropped) { let t = "?"; try { t = store.entityIndex?.byId?.get?.(m.expressId)?.type ?? "?"; } catch {} types[t] = (types[t] ?? 0) + 1; } info.droppedTypes = types; }
          info.write = await saveCacheEntry(key, store, geometryData, bytes.buffer, urls[k].split("/").pop(), { persistSource: plan.persistSource, lastModified: LAST_MODIFIED });
          info.cacheWrittenMs = ms();
        }, (e) => { info.write = { ok: false, why: `modèle de données indisponible : ${String(e?.message ?? e)}` }; }));
      }
    }
    if (stale()) return;
    if (first) throw new Error(multi ? "the files produced no geometry" : "the file produced no geometry");
    const renderer = await rendererReady;
    renderer.fitToView();
    await drawn(renderer);
    report("done", multi ? { bytes: total, models: files.length } : { bytes: total });
    const b = renderer.getModelBounds();
    const r3 = (v) => [v.x, v.y, v.z].map((x) => Math.round(x * 1000) / 1000);
    Object.assign(extra, { triangles, meshes: uploadedMeshes, instancedTriangles, instancedOccurrences, bounds: b ? { min: r3(b.min), max: r3(b.max) } : null }); // local (trajet 2) : + gabarits
    await publishProperties(extra, jobs, background);
  } catch (e) {
    if (window.__benchExtra) window.__benchExtra.complete = true;
    report("failed", { message: String(e?.message ?? e) });
  }
}

// The camera path's adapter (tools/camera-path.mjs): the bounds fitToView frames
// (getModelBounds, Y-up world), the camera's up, and setPosition/setTarget, which apply at once
// (no animation); requestRender() so the frame loop above draws the pose on the next frame.
const vec = ({ x, y, z }) => [x, y, z];
installCameraPath({
  camera: {
    box() {
      const b = gpu?.renderer.getModelBounds();
      return b ? { min: vec(b.min), max: vec(b.max) } : null;
    },
    up: () => vec(gpu.renderer.getCamera().getUp()),
    set(eye, target) {
      const camera = gpu.renderer.getCamera();
      camera.stopInertia();
      camera.setPosition(...eye);
      camera.setTarget(...target);
      gpu.renderer.requestRender();
    },
  },
});

// local (#796): multi, every part of an assembly in one scene (loadParts).
createPane({ tool: "ifclite", version, ext: "ifc", load, multi: true });
