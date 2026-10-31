// Pane for That Open Engine. Drives @thatopen/components as its documentation shows: a world
// with a simple scene, camera and renderer; IfcLoader for .ifc, the fragments manager for
// .frag. Settings changed from the defaults are marked "changed:" with the reason.
// What each state observes is in README.md here.
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front"; // local (rebench)
import * as WEBIFC from "web-ifc";
import { createPane } from "../pane.mjs";
import { installCameraPath } from "../camera-path.mjs";
import pkg from "./package.json";

const container = document.getElementById("viewer");
const dep = (name) => pkg.dependencies[name];
const version0 = `components ${dep("@thatopen/components")}, fragments ${dep("@thatopen/fragments")}, web-ifc ${dep("web-ifc")}, three ${dep("three")}`; // local (rebench) : renommée

// local (rebench) : window.__TOC_POST = "off" (défaut) | "composer" | "deferred" : la postproduction de
// local (rebench) : PostproductionRenderer, style COLOR_PEN_SHADOWS, mode COMPOSER ou DEFERRED. window.__TOC_SIMPLE = true
// local (rebench) : ou ?tocSimple : OBC.SimpleRenderer à la place (référence de coût de la passe géométrie).
// local (rebench) : window.__TOC_MODE = "webgpu" : PostproductionRenderer en { mode: "webgpu" } (bundle dist-webgpu/, three résolu
// local (rebench) : en three/webgpu). Le chargement échoue (« not WebGPU ») si le renderer n'est pas un WebGPURenderer sur un
// local (rebench) : backend WebGPU : ni bundle WebGL, ni repli WebGL de three. En WebGPU, __TOC_POST = "webgpu-tsl" (composition TSL).
const tocMode = window.__TOC_MODE === "webgpu" ? "webgpu" : "webgl"; // local (rebench)
const tocPost = (tocMode === "webgpu" ? ["webgpu-tsl"] : ["composer", "deferred"]).includes(window.__TOC_POST) ? window.__TOC_POST : "off"; // local (rebench)
// local (rebench) : ?tocSimple (sans valeur, ce que fair-probe transmet : il coupe sa config au « = ») ou ?tocSimple=1.
const tocSimpleQs = new URLSearchParams(location.search).get("tocSimple"); // local (rebench)
const tocSimple = window.__TOC_SIMPLE === true || (tocSimpleQs !== null && tocSimpleQs !== "0"); // local (rebench)
const version = `${version0}, components-front ${dep("@thatopen/components-front")} ${tocSimple ? "renderer=simple" : `post=${tocPost}`}${tocMode === "webgpu" ? " mode=webgpu" : ""}`; // local (rebench)

// local (rebench) : WebGPU : l'adaptateur réellement obtenu par three, relevé par une enveloppe de GPUAdapter.prototype.requestDevice
// local (rebench) : (comme le pane Scenoptic), posée avant la création du renderer.
let gpuAdapterInfo = null; // local (rebench)
if (tocMode === "webgpu" && globalThis.GPUAdapter?.prototype?.requestDevice) { // local (rebench)
  const wrapped = GPUAdapter.prototype.requestDevice; // local (rebench)
  GPUAdapter.prototype.requestDevice = async function (...a) { const d = await wrapped.apply(this, a); gpuAdapterInfo = { vendor: this.info?.vendor, architecture: this.info?.architecture, description: this.info?.description }; return d; }; // local (rebench)
} // local (rebench)

// local (rebench) : contrôle du rendu effectif après components.init() et l'init asynchrone de three : renderer.three doit être un
// local (rebench) : WebGPURenderer (isWebGPURenderer) et son backend un WebGPUBackend (backend.isWebGPUBackend) ; three bascule sinon
// local (rebench) : en silence sur son WebGLBackend (navigator.gpu absent, adaptateur refusé).
async function assertWebGPU(renderer) { // local (rebench)
  const three = renderer.three; // local (rebench)
  if (!three?.isWebGPURenderer) throw new Error(`not WebGPU: renderer.three est ${three?.constructor?.name ?? three} (api ${renderer.api})`); // local (rebench)
  await three.init(); // local (rebench) : même promesse que celle lancée par le constructeur
  if (three.backend?.isWebGPUBackend !== true) throw new Error(`not WebGPU: backend ${three.backend?.isWebGLBackend ? "WebGLBackend" : (three.backend?.constructor?.name ?? three.backend)} (repli WebGL de three)`); // local (rebench)
} // local (rebench)

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

let engine; // created on the first load: the world, the loaders; kept for later loads
async function startEngine() {
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  // local (rebench) : PostproductionRenderer (components-front) sauf drapeau __TOC_SIMPLE.
  // local (rebench) : en WebGPU, { mode: "webgpu" } ; une erreur de construction (three classique : pas de WebGPURenderer) devient « not WebGPU ».
  const rendererParams = tocMode === "webgpu" ? { mode: "webgpu" } : undefined; // local (rebench)
  try { // local (rebench)
    world.renderer = tocSimple ? new OBC.SimpleRenderer(components, container, rendererParams) : new OBF.PostproductionRenderer(components, container, rendererParams); // local (rebench)
  } catch (error) { // local (rebench)
    if (tocMode === "webgpu") throw new Error(`not WebGPU: ${error?.message ?? error}`); // local (rebench)
    throw error; // local (rebench)
  } // local (rebench)
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  components.init();
  if (tocMode === "webgpu") await assertWebGPU(world.renderer); // local (rebench)
  // local (rebench) : window.__TOC_NO_INSTANCE_FIX = true coupe le contournement (preuve que le contrôle pane-eval voit l'exception).
  if (tocMode === "webgpu" && window.__TOC_NO_INSTANCE_FIX !== true) world.renderer.onBeforeUpdate.add(() => boundInstanceCounts(world.scene.three)); // local (rebench)
  if (!tocSimple) configurePostproduction(world.renderer); // local (rebench)
  world.scene.setup();
  world.camera.controls.setLookAt(12, 6, 8, 0, 0, -10);

  const fragments = components.get(OBC.FragmentsManager);
  // changed: the worker is served from dist/ because the library's default downloads it from
  // unpkg, which the cross-origin isolation headers (require-corp) block.
  fragments.init(new URL("fragments-worker.mjs", import.meta.url).href);
  world.camera.controls.addEventListener("update", () => fragments.core.update());
  // local (#796): ?tocLod=geometry (LodMode.ALL_GEOMETRY : plus de boîtes filaires, les petits objets lointains restent
  // cachés) ou ?tocLod=all (LodMode.ALL_VISIBLE : tout en géométrie complète). Par défaut : LodMode.DEFAULT.
  const tocLod = { geometry: 2, all: 1 }[new URLSearchParams(location.search).get("tocLod")];
  fragments.list.onItemSet.add(({ value: model }) => {
    if (tocLod !== undefined) model.setLodMode(tocLod);
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
  });

  const ifcLoader = components.get(OBC.IfcLoader);
  const wasmPath = new URL("wasm/", import.meta.url).href;
  // changed: web-ifc picks its multi-threaded build whenever the page is cross-origin isolated
  // (the server's COOP/COEP headers), and its pthread workers then fail in this bundle with
  // "worker sent an error!" and the load never ends. Initialising web-ifc once here with
  // forceSingleThread caches the single-threaded module for every later Init (IfcLoader's and
  // the importer's own). Without the isolation headers the library would choose it anyway.
  const api = new WEBIFC.IfcAPI();
  api.SetWasmPath(wasmPath, true);
  await api.Init(undefined, true);
  // changed: web-ifc's wasm is served from dist/wasm/ (no CDN).
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: { path: wasmPath, absolute: true },
  });
  return { components, world, fragments, ifcLoader };
}

// local (rebench) : WebGPU : fragments 3.6 dessine ses boîtes de LOD (LODGeometry, une InstancedBufferGeometry) sans jamais
// local (rebench) : écrire instanceCount, qui reste à Infinity. three en WebGL borne le nombre d'instances par celui des attributs
// local (rebench) : instanciés (_maxInstanceCount) ; WebGPURenderer passe la valeur telle quelle à drawIndexed, qui lève
// local (rebench) : « Value is infinite » et interrompt l'image (maquette incomplète, image noire avec la composition TSL).
// local (rebench) : Contournement : sur chaque InstancedBufferGeometry à instanceCount infini, un accesseur qui renvoie la même borne
// local (rebench) : que WebGL (min de count × meshPerAttribute des attributs instanciés). Posé une fois par géométrie (marque).
function boundInstanceCounts(root) { // local (rebench)
  root.traverse((o) => { // local (rebench)
    const g = o.geometry; // local (rebench)
    if (!g?.isInstancedBufferGeometry || g.__benchBounded || g.instanceCount !== Infinity) return; // local (rebench)
    g.__benchBounded = true; // local (rebench)
    let own = Infinity; // local (rebench) : valeur écrite par la bibliothèque, si elle en écrit une un jour
    Object.defineProperty(g, "instanceCount", { // local (rebench)
      configurable: true, // local (rebench)
      get() { // local (rebench)
        let max = Infinity; // local (rebench)
        for (const a of Object.values(this.attributes)) if (a.isInstancedBufferAttribute || a.isInstancedInterleavedBuffer || a.data?.isInstancedInterleavedBuffer) max = Math.min(max, (a.meshPerAttribute ?? a.data?.meshPerAttribute ?? 1) * a.count); // local (rebench)
        return Math.min(own, max === Infinity ? 0 : max); // local (rebench)
      }, // local (rebench)
      set(v) { own = v; }, // local (rebench)
    }); // local (rebench)
  }); // local (rebench)
} // local (rebench)

// local (rebench) : réglages de la passe effets (contraintes du rebench) : ni coupure en navigation
// local (rebench) : (turnOffOnManualMode), ni résolution adaptative ; cssSize reste à sa valeur par défaut (false).
// local (rebench) : Ordre : enabled (crée le composer), puis mode, puis style (le setter de mode réapplique le style).
// local (rebench) : « off » n'écrit pas enabled = false : la postproduction l'est déjà, et ce setter lit basePass,
// local (rebench) : qui n'existe qu'après l'initialisation (exception « Base pass not initialized »).
function configurePostproduction(renderer) { // local (rebench)
  renderer.turnOffOnManualMode = false; // local (rebench)
  renderer.adaptiveResolution = false; // local (rebench)
  const pp = renderer.postproduction; // local (rebench)
  if (tocPost === "off") return; // local (rebench)
  pp.enabled = true; // local (rebench)
  // local (rebench) : WebGPU : pas de mode COMPOSER/DEFERRED, la composition TSL dessine la postproduction ; seul le style s'écrit.
  if (tocMode !== "webgpu") pp.mode = tocPost === "deferred" ? OBF.PostproductionMode.DEFERRED : OBF.PostproductionMode.COMPOSER; // local (rebench)
  pp.style = OBF.PostproductionAspect.COLOR_PEN_SHADOWS; // local (rebench)
} // local (rebench)

// local (rebench) : état réel, lu sur les objets de la bibliothèque (pas sur les drapeaux) ; extra.toc au done et
// local (rebench) : window.__benchTocRead() pour une relecture en direct.
function readToc() { // local (rebench)
  const r = engine?.world.renderer; // local (rebench)
  if (!r) return null; // local (rebench)
  const isPost = r instanceof OBF.PostproductionRenderer; // local (rebench)
  const pp = isPost ? r.postproduction : null; // local (rebench)
  const gpu = r.api === "webgpu"; // local (rebench)
  const post = pp?.enabled ? (gpu ? "webgpu-tsl" : pp.mode === OBF.PostproductionMode.DEFERRED ? "deferred" : "composer") : "off"; // local (rebench)
  // local (rebench) : rendu effectif : « webgpu » seulement sur un backend WebGPU (le repli WebGL de three se lit « webgpu-webgl-backend »).
  const effective = gpu ? (r.three?.backend?.isWebGPUBackend === true ? "webgpu" : "webgpu-webgl-backend") : (r.api ?? "webgl"); // local (rebench)
  return { // local (rebench)
    version, // local (rebench)
    renderer: effective, // local (rebench)
    backend: r.three?.backend?.isWebGPUBackend ? "WebGPUBackend" : r.three?.backend?.isWebGLBackend ? "WebGLBackend" : (r.three?.backend?.constructor?.name ?? null), // local (rebench) : noms de classes minifiés dans le bundle
    adapter: gpu ? gpuAdapterInfo : null, // local (rebench)
    rendererClass: isPost ? "PostproductionRenderer" : "SimpleRenderer", // local (rebench)
    post, // local (rebench)
    style: pp ? pp.style : null, // local (rebench)
    mode: pp ? (pp.mode ?? null) : null, // local (rebench)
    turnOffOnManualMode: isPost ? r.turnOffOnManualMode : null, // local (rebench)
    adaptiveResolution: isPost ? r.adaptiveResolution : null, // local (rebench)
    cssSize: isPost ? r.cssSize : null, // local (rebench)
    // local (rebench) : revue finale, important 7 : résolution en mouvement RÉELLE (components-front 3.6, WebGPU seulement :
    // local (rebench) : PostproductionRenderer.movingResolution.enabled, off par défaut) ; null si la bibliothèque ne l'a pas.
    movingResolution: isPost && r.movingResolution ? { enabled: !!r.movingResolution.enabled, scale: r.movingResolution.scale ?? null, active: r.movingResolution.active ?? null, switches: r.movingResolution.switches ?? null } : null, // local (rebench)
    rendererMode: r.mode, // local (rebench)
  }; // local (rebench)
} // local (rebench)
window.__benchTocRead = readToc; // local (rebench)
// local (rebench) : extra du pane, lu par scripts/view.mjs et pane-eval (window.__benchExtra).
const publishExtra = () => { window.__benchExtra = { complete: true, toc: readToc() }; }; // local (rebench)

async function fetchBytes(url, report) {
  report("fetching");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  report("parsing", { bytes: bytes.length });
  return bytes;
}

function fitCamera(world, model) {
  const box = model.box.clone();
  if (box.isEmpty()) return;
  world.camera.controls.fitToBox(box, false);
}

async function loadModel({ model: id, url, urls = [url], offsets, report }) {
  window.__benchExtra = undefined; // local (rebench) : pas d'extra d'un chargement précédent
  try {
    // local (#796): an assembly (several urls) goes to loadParts; one file loads as before.
    if (urls.length > 1) return await loadParts({ id, urls, offsets, report });
    const isFrag = new URL(url, location.href).pathname.endsWith(".frag");
    const bytes = await fetchBytes(url, report);
    const size = bytes.length; // the fragments worker takes the buffer, leaving it empty
    engine ??= await startEngine();
    const { world, fragments, ifcLoader } = engine;
    for (const old of [...fragments.list.values()]) await fragments.core.disposeModel(old.modelId);
    const model = isFrag
      ? await fragments.core.load(bytes, { modelId: id || "model" })
      : await ifcLoader.load(bytes, true, id || "model");
    fitCamera(world, model);
    await fragments.core.update(true);
    await nextFrame();
    report("first-frame", { bytes: size });
    await fragments.core.update(true);
    report("done", { bytes: size });
    publishExtra(); // local (rebench)
  } catch (error) {
    console.error(error);
    report("failed", { message: String(error?.message ?? error) });
  }
}

// local (#796): every file of an assembly in one world, one fragments model each (modelId
// "<id>-<k>"). Fetched together; .frag files load in parallel (the fragments worker pool takes
// several models at once), .ifc files in series (each IfcLoader.load runs web-ifc's
// single-threaded conversion on the main thread). The library's autoCoordinate (on by default)
// aligns each model's coordinates on the first one's. first-frame: the first model to load is
// framed and drawn, as a single file is; done: all loaded, the camera fitted to the union.
async function loadParts({ id, urls, offsets, report }) {
  report("fetching");
  const buffers = await Promise.all(urls.map(async (u) => {
    const response = await fetch(u);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${u}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const size = buffers.reduce((t, b) => t + b.length, 0);
  report("parsing", { bytes: size });
  engine ??= await startEngine();
  const { world, fragments, ifcLoader } = engine;
  for (const old of [...fragments.list.values()]) await fragments.core.disposeModel(old.modelId);
  let first;
  const onFirst = async (model) => {
    if (first) return first;
    first = (async () => {
      model.object.updateMatrixWorld(true);
      fitCamera(world, model);
      await fragments.core.update(true);
      await nextFrame();
      report("first-frame", { bytes: size });
    })();
    return first;
  };
  const loadOne = async (bytes, k) => {
    const isFrag = new URL(urls[k], location.href).pathname.endsWith(".frag");
    const modelId = `${id || "model"}-${k}`;
    const model = isFrag ? await fragments.core.load(bytes, { modelId }) : await ifcLoader.load(bytes, true, modelId);
    // local : matrice d'assemblage, décalage ajouté après l'alignement autoCoordinate (monde Y-up).
    const off = offsets?.[k];
    if (off && off.some((x) => x !== 0)) { model.object.position.x += off[0]; model.object.position.y += off[1]; model.object.position.z += off[2]; model.object.updateMatrixWorld(true); }
    onFirst(model);
    return model;
  };
  const allFrag = urls.every((u) => new URL(u, location.href).pathname.endsWith(".frag"));
  const models = [];
  if (allFrag) models.push(...(await Promise.all(buffers.map(loadOne))));
  else for (let k = 0; k < buffers.length; k++) models.push(await loadOne(buffers[k], k));
  await first;
  // model.box reads matrixWorld, which lags the autoCoordinate shift until the next render.
  for (const m of models) m.object.updateMatrixWorld(true);
  const box = models[0].box.clone();
  for (const m of models.slice(1)) box.union(m.box);
  if (!box.isEmpty()) {
    // local (#796): the library's camera is PerspectiveCamera(60, aspect, 1, 1000); an assembly
    // with its city context is over a kilometre wide and was cut by the far plane. Far covers the
    // whole box from anywhere the camera path goes (it orbits at 1.6 radii); near is left as is.
    const cam = world.camera.three;
    const diag = box.max.distanceTo(box.min);
    if (cam.far < 3 * diag) { cam.far = 3 * diag; cam.updateProjectionMatrix(); }
    world.camera.controls.fitToBox(box, false);
  }
  await fragments.core.update(true);
  await nextFrame();
  report("done", { bytes: size, models: models.length });
  publishExtra(); // local (rebench)
}

// The camera path's adapter (tools/camera-path.mjs): the union of the loaded models' boxes, the
// camera's up, and camera-controls' setLookAt without transition. The rest is the library's own
// loop: components.init() runs a requestAnimationFrame loop that updates the controls (which fire
// "update", so fragments.core.update() picks tiles and LOD as for a user's drag, throttled by the
// library) and renders every tick (SimpleRenderer's default mode is AUTO).
installCameraPath({
  camera: {
    box() {
      if (!engine) return null;
      const models = [...engine.fragments.list.values()];
      if (!models.length) return null;
      const box = models[0].box.clone();
      for (const m of models.slice(1)) box.union(m.box);
      return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
    },
    up: () => engine.world.camera.three.up.toArray(),
    async set([ex, ey, ez], [tx, ty, tz]) {
      await engine.world.camera.controls.setLookAt(ex, ey, ez, tx, ty, tz, false);
    },
  },
});

// local (#796): multi, every part of an assembly in one world (loadParts).
createPane({ tool: "thatopen", version, ext: "ifc", load: loadModel, multi: true });
