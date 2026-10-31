// Pane for BIM Open Viewer. The viewer is used as a library: createViewer on a canvas, then
// viewer.open(url), whose loaders report fetch and parse progress. See README.md here.
import { createViewer } from "@bim-open-viewer/viewer";
import { REVISION } from "three";
import { createPane } from "../../pane.mjs";
import { installCameraPath } from "../../camera-path.mjs";

const stage = document.getElementById("stage");

async function version() {
  try {
    const pin = await (await fetch("tool.json")).json();
    return `${pin.commit.slice(0, 7)}, three r${REVISION}`;
  } catch {
    return `unknown, three r${REVISION}`;
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const describe = (diagnostics) => diagnostics.map((d) => d.message).join("; ") || "load failed";

// What this pane holds between loads, so a second load starts clean.
let current;
function release() {
  current?.abort.abort();
  current?.viewer.dispose();
  current?.canvas.remove();
  current = undefined;
}

async function load({ url, urls = [url], report }) {
  // local (#796): an assembly (several urls) goes to loadParts; one file loads as before.
  if (urls.length > 1) return loadParts({ urls, report });
  release();
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  const viewer = createViewer(canvas);
  const abort = new AbortController();
  const mine = { canvas, viewer, abort };
  current = mine;
  const stale = () => current !== mine;

  report("fetching");
  const problem = viewer.diagnostics().find((d) => d.severity === "error");
  if (problem) return report("failed", { message: problem.message });

  let bytes;
  let parsing = false;
  const onProgress = ({ phase, loaded }) => {
    if (stale()) return;
    if (phase === "fetch") { bytes = loaded; return; }
    // The first event after the fetch phase means the bytes are in hand and parsing has begun.
    if (!parsing) { parsing = true; report("parsing", { bytes }); }
  };

  try {
    const opened = await viewer.open(new URL(url, location.href).href, { onProgress, signal: abort.signal });
    if (stale()) return;
    if (!opened.ok) return report("failed", { message: describe(opened.diagnostics) });
    if (!parsing) report("parsing", { bytes });
    // viewer.open has bound the model and fitted the camera. Its frame loop draws on the next
    // animation frame, ahead of this callback, which was queued after it.
    await nextFrame();
    if (stale()) return;
    report("first-frame", { bytes });
    report("done", { bytes });
  } catch (error) {
    if (!stale()) report("failed", { message: String(error?.message ?? error) });
  }
}

// local (#796): every file of an assembly in one viewer, opened in parallel: viewer.open keeps
// every model it shows (in the order shown, each under its file name as model id) and binds each
// as it arrives, so several opens at once are what the API allows. Each show fits the views to
// the bounds of every model bound so far, the last one to their union. `parsing`: every file has
// left its fetch phase, with their total size; first-frame: the first model shown and one frame
// drawn, as a single file is; done: every model shown (the camera then on the union), one frame.
async function loadParts({ urls, report }) {
  release();
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  const viewer = createViewer(canvas);
  const abort = new AbortController();
  const mine = { canvas, viewer, abort };
  current = mine;
  const stale = () => current !== mine;

  report("fetching");
  const problem = viewer.diagnostics().find((d) => d.severity === "error");
  if (problem) return report("failed", { message: problem.message });

  const sizes = urls.map(() => 0);
  const fetched = urls.map(() => false);
  let parsing = false;
  const total = () => sizes.reduce((t, b) => t + b, 0);
  const toParsing = () => { if (!parsing && fetched.every(Boolean)) { parsing = true; report("parsing", { bytes: total() }); } };
  let firstShown;
  const openOne = async (u, k) => {
    const onProgress = ({ phase, loaded }) => {
      if (stale()) return;
      if (phase === "fetch") { sizes[k] = loaded; return; }
      if (!fetched[k]) { fetched[k] = true; toParsing(); }
    };
    const opened = await viewer.open(new URL(u, location.href).href, { onProgress, signal: abort.signal });
    if (!opened.ok) throw new Error(describe(opened.diagnostics));
    fetched[k] = true;
    toParsing();
    firstShown ??= nextFrame().then(() => { if (!stale()) report("first-frame", { bytes: total() }); });
  };

  try {
    await Promise.all(urls.map(openOne));
    if (stale()) return;
    await firstShown;
    await nextFrame();
    if (stale()) return;
    report("done", { bytes: total(), models: urls.length });
  } catch (error) {
    if (!stale()) report("failed", { message: String(error?.message ?? error) });
  }
}

// The camera path's adapter (tools/camera-path.mjs), in the viewer's own world: the bounds that
// view.fit frames, the first view's up, and view.look (no flight) as a saved-view restore does.
// The view's frame loop draws on the next animation frame once the camera moved; requestRender
// makes sure of it even when the pose did not change.
const firstView = () => current?.viewer.views.all()[0];
installCameraPath({
  camera: {
    box() {
      const b = current?.viewer.bounds();
      if (!b || b.min[0] > b.max[0] || b.min[1] > b.max[1] || b.min[2] > b.max[2]) return null;
      return { min: [...b.min], max: [...b.max] };
    },
    up: () => [...(firstView()?.camera().camera.up ?? [0, 0, 1])],
    set(eye, target) {
      const view = firstView();
      if (!view) return;
      const state = view.camera();
      const looked = current.viewer.run("view.look", { view: view.id, camera: { ...state, camera: { ...state.camera, position: eye, target } } });
      if (!looked.ok) throw new Error(describe(looked.diagnostics));
      view.requestRender();
    },
  },
});

// local (#796): multi, every part of an assembly in one viewer (loadParts).
createPane({ tool: "bim-open-viewer", version: await version(), ext: "bos", load, multi: true });
