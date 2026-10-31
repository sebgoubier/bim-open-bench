// LOCAL ONLY (rebench tâche 9) : fonctions pures du rapport du rebench concurrents (scripts/rebench-report.mjs).
// Entrées : <machine>/open.json (view.mjs), <machine>/gpu/<tool>--<form>--<model>.json (gpu-path-probe), journal.log,
// models.json. Sortie : une page HTML autonome (aucune ressource externe), claire et sombre, lisible sur téléphone.
// Une case absente affiche « — » ; une case qui n'ouvre pas est classée dernière ; une case sans temps GPU fiable
// affiche « non mesuré », jamais le rAF.
// Revue finale (vague unique) : C5c deux tableaux classés par axe, « format converti » et « IFC brut », qui alimentent
// tous deux « Où on perd » ; C5a ouverture et RAM de Scenoptic par les panes -meta (avec métadonnées) ; C6 médiane des
// 3 répétitions GPU et leur dispersion ; imp. 1 concurrents marqués classés avec ⚑, toutes les exclusions listées ;
// imp. 2 repos ramené à 60 Hz ; imp. 7 anticrénelage, movingResolution et post dérivés des sorties ; imp. 9 libellés.
import { gpuRepeatsFor, VIEWERS, isScenoptic, mainFormFor, propsPolicy, shotsAllowed } from "./rebench-matrix.mjs";
import { KIT } from "./kit-profile.mjs"; // kit v2 : modelTools (null sur le banc principal)

export const MACHINES = ["4090", "igpu"];
export const MACHINE_LABEL = { "4090": "RTX 4090 (portable)", igpu: "iGPU Intel" };

// Lignes principales (classées) ; ordre des colonnes des tableaux. C5c : « format converti » (forme principale de
// chaque viewer) et « IFC brut » (.ifc lu dans le navigateur), deux classements séparés.
// 26/10 (cache ifc-lite) : ifc-lite entre au tableau « format converti » avec sa forme principale « ifc-cache » (le cache
// IndexedDB de son viewer, amorcé par une ouverture non comptée) ; en fluidité, sa forme gpu (l'IFC brut : même géométrie).
export const MAIN_TOOLS = ["scenoptic-webgpu-rb", "scenoptic-rb", "thatopen", "thatopen-webgpu", "ifclite", "bim-open-viewer", "xeokit"];
export const IFC_TOOLS = ["scenoptic-webgpu-rb", "scenoptic-rb", "thatopen", "thatopen-webgpu", "ifclite", "xeokit"];
export const TABLE_KINDS = [
  { id: "conv", title: "Format converti", tools: MAIN_TOOLS, form: (tool, suite = "open") => mainFormFor(tool, suite) },
  { id: "ifc", title: "IFC brut", tools: IFC_TOOLS, form: () => "ifc" },
];
/** 26/10 : ligne d'explication sous le tableau « format converti » (forme ifc-cache d'ifc-lite). */
export const CACHE_NOTE = "ifc-lite (format converti) : le cache IndexedDB de son viewer, construit à la 1re ouverture du fichier dans ce navigateur (amorçage non compté, son temps est donné comme conversion dans les conditions), propre à un navigateur et une machine, évictable par le navigateur ; servi pour un modèle principal de 10 à 400 Mo seulement. Les .sgpu de Scenoptic sont convertis une fois côté serveur, pour tous les postes.";
export const CACHE_GPU_NOTE = "ifc-lite : fluidité et repos mesurés sur l'IFC brut (le cache sert la même géométrie).";
// C5a : la suite open de Scenoptic passe par les panes avec métadonnées (même colonne).
export const OPEN_TOOL = { "scenoptic-webgpu-rb": "scenoptic-webgpu-rb-meta", "scenoptic-rb": "scenoptic-rb-meta" };
export const openToolOf = (tool) => OPEN_TOOL[tool] ?? tool;
export const TOOL_LABEL = {
  "scenoptic-webgpu-rb": "Scenoptic WebGPU",
  "scenoptic-rb": "Scenoptic WebGL",
  "scenoptic-webgpu-rb-meta": "Scenoptic WebGPU (avec métadonnées)",
  "scenoptic-rb-meta": "Scenoptic WebGL (avec métadonnées)",
  "scenoptic-webgpu-rb-lambert": "Scenoptic WebGPU Lambert",
  "scenoptic-webgpu-rb-fx": "Scenoptic WebGPU effets",
  "scenoptic-rb-fx": "Scenoptic WebGL effets",
  "scenoptic-webgpu-rb-fx-lambert": "Scenoptic WebGPU effets Lambert",
  thatopen: "That Open WebGL",
  "thatopen-webgpu": "That Open WebGPU",
  "thatopen-fx-composer": "That Open effets COMPOSER",
  "thatopen-fx-deferred": "That Open effets DEFERRED",
  "thatopen-webgpu-fx": "That Open WebGPU effets TSL",
  ifclite: "ifc-lite",
  "bim-open-viewer": "BIM Open Viewer",
  xeokit: "xeokit",
};
// Coût des effets : pane de géométrie → pane(s) effets.
export const FX_PAIRS = [
  ["scenoptic-webgpu-rb", "scenoptic-webgpu-rb-fx"],
  ["scenoptic-rb", "scenoptic-rb-fx"],
  ["thatopen", "thatopen-fx-composer"],
  ["thatopen", "thatopen-fx-deferred"],
  ["thatopen-webgpu", "thatopen-webgpu-fx"],
  ["scenoptic-webgpu-rb-lambert", "scenoptic-webgpu-rb-fx-lambert"],
];
// Colonnes de la planche des captures (Scenoptic contre TOC, géométrie puis effets).
export const SHOT_TOOLS = ["scenoptic-webgpu-rb", "thatopen-webgpu", "scenoptic-rb", "thatopen", "scenoptic-webgpu-rb-fx", "thatopen-webgpu-fx", "scenoptic-rb-fx", "thatopen-fx-composer", "thatopen-fx-deferred"];

const FAILED = new Set(["fail", "ram"]);
const round = (x, d) => { const k = 10 ** d; return Math.round(x * k) / k; };
const num = (x) => typeof x === "number" && Number.isFinite(x);
export const mainForm = (tool) => VIEWERS.find((v) => v.tool === tool)?.forms[0];

/** Médiane (moyenne des deux du milieu pour un nombre pair) ; null sans valeur. */
export function median(xs) {
  const v = xs.filter(num).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Classement par (machine, maquette). Une ligne = { machine, model, tool, status, [metric]: number }.
 * status "fail" / "ram" (n'ouvre pas) ⟹ classée dernière, jamais 1re ; "unmeasured" / "missing" ⟹ hors classement.
 * "flagged" (revue finale, imp. 1) : un CONCURRENT marqué reste classé, avec sa marque (flag) ; une case Scenoptic marquée
 * est écartée (on ne revendique rien sur une mesure douteuse). Toutes les cases écartées sont listées (excluded).
 * @returns {Array<{ machine, model, metric, lowerIsBetter, ranking: Array<{ tool, value, rank, failed }>, firstPlace: string|null, gapPct: number|null }>}
 */
export function rankCells(rows, metric, lowerIsBetter = true) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.machine}\u0000${r.model}`;
    if (!groups.has(k)) groups.set(k, { machine: r.machine, model: r.model, rows: [] });
    groups.get(k).rows.push(r);
  }
  const out = [];
  for (const { machine, model, rows: rs } of groups.values()) {
    const failed = rs.filter((r) => FAILED.has(r.status) || r.failed === true);
    const ranked = (r) => (r.status ?? "ok") === "ok" || (r.status === "flagged" && !isScenoptic(r.tool));
    const ok = rs.filter((r) => !failed.includes(r) && ranked(r) && num(r[metric]));
    ok.sort((a, b) => (lowerIsBetter ? a[metric] - b[metric] : b[metric] - a[metric]));
    const ranking = [
      ...ok.map((r, i) => ({ tool: r.tool, value: r[metric], rank: i + 1, failed: false, source: r.source, flag: r.status === "flagged" ? r.note ?? "marquée" : null })),
      ...failed.map((r) => ({ tool: r.tool, value: null, rank: ok.length + 1, failed: true, source: r.source, note: r.note })),
    ];
    // Cases présentes mais écartées du classement (non mesuré, Scenoptic marquée, sans valeur) : toutes listées.
    const excluded = rs.filter((r) => !failed.includes(r) && !ok.includes(r) && r.status !== "missing" && r.status != null).map((r) => ({ tool: r.tool, status: r.status, note: r.note ?? (num(r[metric]) ? null : "sans valeur"), source: r.source }));
    let gapPct = null;
    if (ok.length >= 2 && ok[0][metric] !== 0) gapPct = round((Math.abs(ok[1][metric] - ok[0][metric]) / Math.abs(ok[0][metric])) * 100, 1);
    out.push({ machine, model, metric, lowerIsBetter, ranking, excluded, firstPlace: ok[0]?.tool ?? null, gapPct, alone: ok.length === 1 && failed.length === 0 });
  }
  return out;
}

/** Coût des effets sur le temps GPU médian par image : { ms, pct } ; null si l'une des deux cases manque. */
export function effectsCost(geoRow, fxRow) {
  const ok = (r) => r && (r.status ?? "ok") === "ok" && num(r.gpuMsMed);
  if (!ok(geoRow) || !ok(fxRow)) return null;
  const ms = round(fxRow.gpuMsMed - geoRow.gpuMsMed, 3);
  return { ms, pct: geoRow.gpuMsMed === 0 ? null : round((ms / geoRow.gpuMsMed) * 100, 1) };
}

/**
 * Cases où un pane Scenoptic n'est pas 1er face à un concurrent : un concurrent mesuré fait strictement mieux, ou
 * Scenoptic n'ouvre pas là où un concurrent ouvre. (Scenoptic WebGL derrière Scenoptic WebGPU n'est pas une perte.)
 * @param {ReturnType<typeof rankCells>} table groupes de rankCells (éventuellement annotés d'un `axis`)
 */
export function losses(table) {
  const out = [];
  for (const g of table) {
    const rivals = g.ranking.filter((r) => !isScenoptic(r.tool) && !r.failed);
    if (!rivals.length) continue;
    const best = rivals[0]; // le classement est déjà trié
    for (const s of g.ranking.filter((r) => isScenoptic(r.tool))) {
      const beaten = s.failed || (g.lowerIsBetter ? best.value < s.value : best.value > s.value);
      if (!beaten) continue;
      const gapPct = s.failed || best.value === 0 ? null : round((Math.abs(s.value - best.value) / Math.abs(best.value)) * 100, 1);
      out.push({ axis: g.axis, kind: g.kind, machine: g.machine, model: g.model, metric: g.metric, tool: s.tool, value: s.value, failed: s.failed, rank: s.rank, source: s.source, winner: best.tool, winnerValue: best.value, winnerSource: best.source, winnerFlag: best.flag ?? null, gapPct });
    }
  }
  return out;
}

/** Cases écartées du classement (non mesuré, Scenoptic marquée…), TOUS viewers (imp. 1), avec leur raison. */
export function excludedCells(table) {
  return table.flatMap((g) => (g.excluded ?? []).map((e) => ({ axis: g.axis, kind: g.kind, machine: g.machine, model: g.model, ...e })));
}
/** Les seules cases Scenoptic de excludedCells. */
export const excludedScenoptic = (table) => excludedCells(table).filter((e) => isScenoptic(e.tool));

/**
 * Case GPU depuis une sortie de gpu-path-probe. On ne publie que path.gpuMs{Med,P95,P99}, path.over100Frac et
 * rest.idleGpuMsPerSec (jamais rest.staticFrameMs ni pathAllFrames).
 */
export const CHAIN_SOURCE = "chaîne";

export function gpuCell(res, journalStatus) {
  if (journalStatus === "RAM") return { status: "ram", note: "n'ouvre pas (RAM)" };
  // kit v2 : case arrêtée au plafond de durée (sous-commande tuée) : la limite du viewer est le résultat.
  if (journalStatus === "TIMEOUT") return { status: "fail", note: "délai de case dépassé (arrêt forcé)" };
  if (!res) return { status: "missing" };
  const source = res.__source ?? CHAIN_SOURCE; // série d'origine : la chaîne, ou le dossier d'un --extra
  const f = res.flags ?? {};
  if (res.lost) return { status: "fail", note: "périphérique perdu", source };
  // Case notée FAIL par la chaîne (chargement non terminé, résultat gardé) : n'ouvre pas.
  if (journalStatus === "FAIL") return { status: "fail", note: /délai dépassé/.test(`${f.reason ?? ""} ${res.status ?? ""}`) ? "délai dépassé" : "n'ouvre pas (chargement non terminé)", source };
  if (f.gpuUnmeasured) return { status: "unmeasured", note: f.reason || "temps GPU non fiable", source };
  if (f.tsQuantized) return { status: "unmeasured", note: "horodatages quantifiés", source };
  // Sortie de sonde sans trajet : rien ne prouve que le viewer n'ouvre pas, on ne sait juste pas.
  if (!res.path) return { status: "unmeasured", note: "sonde sans trajet", source };
  if (!num(res.path.gpuMsMed)) return { status: "unmeasured", note: "trajet sans temps GPU", source };
  // #865 (29/10) : chiffre principal = MOYENNE de toutes les images du trajet (pathAllFrames.gpuMsMean) quand la sonde
  // l'écrit ; la médiane « une image par pas » ne voit qu'une parité dès que les images diffèrent (culling une image sur
  // N). Le champ garde son nom `gpuMsMed` (tri, rangs, tests) ; la médiane par pas reste dans `gpuMsStepMed`.
  const mean = res.pathAllFrames?.gpuMsMean;
  const cell = {
    gpuMsMed: num(mean) ? mean : res.path.gpuMsMed, gpuMsStepMed: res.path.gpuMsMed, gpuMsMean: num(mean) ? mean : null, gpuMsP95: res.path.gpuMsP95, gpuMsP99: res.path.gpuMsP99, over100Frac: res.path.over100Frac,
    idleGpuMsPerSec: res.rest?.idleGpuMsPerSec, idleFramesPerSec: res.rest?.idleFramesPerSec, idle60: idleAt60Hz(res.rest), status: "ok", source,
    ...cpuFields(res),
  };
  const marks = [];
  if (f.partialTiming) marks.push("mesure partielle");
  if (f.boostSuspect) marks.push("boost suspect");
  if (marks.length) { cell.status = "flagged"; cell.note = marks.join(", "); }
  return cell;
}

/**
 * kit v2 (30/10) : CPU des processus Chrome (ms de CPU par seconde, 1 000 = un cœur plein), en mouvement (trajet) et au
 * repos (caméra immobile). Le banc tourne sans vsync : un viewer qui dessine en boucle (That Open : ~800 i/s sur la 4090)
 * brûle du CPU au prorata de sa cadence. Comme le repos GPU (imp. 2), chiffre principal RAMENÉ À 60 i/s quand le viewer
 * dessine plus vite (ms par image × 60) ; un viewer à 60 i/s ou moins garde son chiffre brut (jamais extrapolé vers le haut).
 */
export function cpuAt60(totalMsPerSec, fps) {
  if (!num(totalMsPerSec)) return null;
  return num(fps) && fps > 60 ? round((totalMsPerSec / fps) * 60, 1) : totalMsPerSec;
}
export function cpuFields(res) {
  const c = res?.cpu, ci = res?.cpuIdle;
  const fps = c && num(res.pathAllFrames?.frames) && c.wallMs > 0 ? res.pathAllFrames.frames / (c.wallMs / 1000) : null;
  const idleFps = res?.rest?.idleFramesPerSec;
  return {
    cpuMsPerSec: c?.totalMsPerSec ?? null, cpuFps: num(fps) ? round(fps, 0) : null, cpu60: cpuAt60(c?.totalMsPerSec, fps),
    cpuMsPerFrame: num(fps) && fps > 0 && num(c?.totalMsPerSec) ? round(c.totalMsPerSec / fps, 2) : null,
    cpuGpuProcMsPerSec: c?.msPerSec?.gpu ?? null, cpuRendererMsPerSec: c?.msPerSec?.renderer ?? null, cpuMainTaskMsPerSec: c?.mainThread?.taskMsPerSec ?? null,
    cpuIdleMsPerSec: ci?.totalMsPerSec ?? null, cpuIdle60: cpuAt60(ci?.totalMsPerSec, idleFps),
  };
}

/**
 * Revue finale, imp. 2 : repos ramené à 60 Hz. idleGpuMsPerSec est mesuré sans vsync (That Open WebGL à 1 091 i/s ⟹
 * 496 ms/s) ; idleGpuMsPerSec / idleFramesPerSec × 60 = le travail par seconde du même viewer à 60 Hz. Aucune image ⟹ 0.
 */
export function idleAt60Hz(rest) {
  if (!rest || !num(rest.idleGpuMsPerSec)) return null;
  if (!num(rest.idleFramesPerSec) || rest.idleFramesPerSec <= 0) return rest.idleGpuMsPerSec === 0 ? 0 : null;
  return round((rest.idleGpuMsPerSec / rest.idleFramesPerSec) * 60, 3);
}

/**
 * Revue finale C6 : une case GPU = la médiane de ses répétitions valides (ok / marquée), avec leur dispersion
 * (min, max, écart max-min en % de la médiane). Aucune valide ⟹ l'état de la première présente (échec d'abord).
 * Une répétition marquée marque la case ; des répétitions invalides à côté de valides ⟹ « k/n répétitions ».
 * @param {ReturnType<typeof gpuCell>[]} cells une par répétition (missing compris)
 */
export function gpuCellReps(cells) {
  const present = cells.filter((c) => c && c.status !== "missing");
  if (!present.length) return { status: "missing" };
  const good = present.filter((c) => c.status === "ok" || c.status === "flagged");
  if (!good.length) {
    const order = ["fail", "ram", "unmeasured"];
    return { ...present.slice().sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0], reps: 0, repsPresent: present.length };
  }
  const M = (k) => median(good.map((c) => c[k]));
  const v = good.map((c) => c.gpuMsMed).filter(num), med = median(v);
  const cell = {
    gpuMsMed: med, gpuMsP95: M("gpuMsP95"), gpuMsP99: M("gpuMsP99"), over100Frac: M("over100Frac"),
    idleGpuMsPerSec: M("idleGpuMsPerSec"), idleFramesPerSec: M("idleFramesPerSec"), idle60: M("idle60"),
    cpuMsPerSec: M("cpuMsPerSec"), cpuFps: M("cpuFps"), cpu60: M("cpu60"), cpuMsPerFrame: M("cpuMsPerFrame"), cpuGpuProcMsPerSec: M("cpuGpuProcMsPerSec"), cpuRendererMsPerSec: M("cpuRendererMsPerSec"), cpuMainTaskMsPerSec: M("cpuMainTaskMsPerSec"), cpuIdleMsPerSec: M("cpuIdleMsPerSec"), cpuIdle60: M("cpuIdle60"),
    reps: good.length, repsPresent: present.length, status: "ok", source: good[0].source,
    spread: v.length > 1 ? { min: Math.min(...v), max: Math.max(...v), pct: med ? round(((Math.max(...v) - Math.min(...v)) / med) * 100, 1) : null } : null,
  };
  const marks = [...new Set(good.filter((c) => c.status === "flagged").flatMap((c) => String(c.note).split(", ")))];
  if (good.length < present.length) marks.push(`${good.length}/${present.length} répétitions`);
  if (marks.length) { cell.status = "flagged"; cell.note = marks.join(", "); }
  return cell;
}

/** Case d'ouverture depuis les enregistrements de view.mjs (renderer matériel) : médianes des 3 répétitions. */
export function openCell(runs, tool, model, form, journalStatus) {
  if (journalStatus === "RAM") return { status: "ram", note: "n'ouvre pas (RAM)" };
  if (journalStatus === "TIMEOUT") return { status: "fail", note: "délai de case dépassé (arrêt forcé)" }; // kit v2
  const recs = (runs ?? []).filter((r) => r.tool === tool && r.model === model && r.form === form && (r.renderer ?? "hardware") === "hardware");
  if (!recs.length) return { status: "missing" };
  const source = recs[0].__source ?? CHAIN_SOURCE;
  // Une répétition = un Chrome neuf (rep), passe 0 à froid puis rechargements ; elle compte si TOUTES ses passes ont fini.
  const repIds = [...new Set(recs.map((r) => r.rep ?? 0))];
  const okReps = repIds.filter((k) => recs.filter((r) => (r.rep ?? 0) === k).every((r) => r.outcome === "done"));
  if (!okReps.length) {
    const bad = recs.find((r) => r.outcome !== "done");
    return { status: "fail", note: bad?.outcome === "timeout" ? "délai dépassé" : "n'ouvre pas", source };
  }
  const mine = recs.filter((r) => okReps.includes(r.rep ?? 0));
  const cold = mine.filter((r) => (r.pass ?? 0) === 0), warm = mine.filter((r) => (r.pass ?? 0) > 0);
  // 26/10 : forme -cache (ifc-lite) : un modèle principal hors des paliers (< 10 Mo, > 400 Mo) n'a pas de cache ; la
  // case le dit au lieu d'un chiffre qui ne serait que l'IFC brut à froid. Palier lu dans extra.cache[0] (le pane).
  if (/-cache$/.test(form)) {
    const primary = (r) => r.extra?.cache?.[0] ?? r.prime?.cache?.[0];
    const none = cold.find((r) => primary(r)?.tier === "none");
    if (none) return { status: "nocache", note: primary(none).reason ?? "pas de cache", source, cacheTier: "none" };
  }
  // 26/10 : deux instants. Géométrie à l'écran = done ; propriétés disponibles = extra.propsReadyMs mesuré par le pane,
  // sinon done chez un viewer qui les charge dans le même appel (at-done), sinon done + metadataMs (anciens sidecars).
  const policy = propsPolicy(tool);
  const geom = (r) => (num(r.doneMs) ? r.doneMs : null);
  const props = (r) => {
    if (!num(r.doneMs)) return null;
    if (num(r.extra?.propsReadyMs)) return Math.max(r.extra.propsReadyMs, r.doneMs);
    if (policy === "at-done") return r.doneMs;
    return num(r.extra?.metadataMs) ? r.doneMs + r.extra.metadataMs : null;
  };
  // RAM / VRAM : pic du chargement ET de l'après-chargement (métadonnées, travail différé), pas seulement jusqu'à done.
  const peak = (r, k) => { const a = r.memory?.load?.[k], b = r.memory?.afterLoad?.[k]; return num(a) || num(b) ? Math.max(num(a) ? a : 0, num(b) ? b : 0) : null; };
  const vram = (r) => (num(peak(r, "gpuDedMB")) ? peak(r, "gpuDedMB") + (peak(r, "gpuShrMB") ?? 0) : null);
  const cell = {
    status: "ok",
    coldFirstFrameMs: median(cold.map((r) => r.firstFrameMs)), coldDoneMs: median(cold.map(geom)),
    coldPropsMs: median(cold.map(props)), propsPolicy: policy,
    warmFirstFrameMs: median(warm.map((r) => r.firstFrameMs)), warmDoneMs: median(warm.map(geom)),
    metadataMs: median(cold.map((r) => r.extra?.metadataMs)),
    ramMB: median(cold.map((r) => peak(r, "ramMB"))), vramMB: median(cold.map(vram)),
    gpuDedMB: median(cold.map((r) => peak(r, "gpuDedMB"))), gpuShrMB: median(cold.map((r) => peak(r, "gpuShrMB"))),
    reps: okReps.length, version: recs[0].version, conversion: recs[0].conversion ?? null, source,
  };
  if (/-cache$/.test(form)) {
    // Amorçage (= conversion d'ifc-lite) : médiane des répétitions ; une passe 0 que le cache n'a pas servie est marquée.
    cell.cacheTier = cold.map((r) => r.extra?.cache?.[0]?.tier).find(Boolean) ?? null;
    cell.primeMs = median(cold.map((r) => r.conversion?.ms));
    const missed = cold.filter((r) => r.extra?.cache?.[0]?.hit !== true).length;
    if (missed) { cell.status = "flagged"; cell.note = `cache non servi ${missed}/${cold.length}`; }
  }
  // Mineur de la revue : une répétition sur trois en échec ⟹ « 2/3 », pas « n'ouvre pas ».
  if (okReps.length < repIds.length) { cell.status = "flagged"; cell.note = `${okReps.length}/${repIds.length} ouvertures`; }
  return cell;
}

/**
 * Garde anti-fuite : lève « fuite » si le HTML contient un chemin disque (D:/, C:/…), un nom de fichier .ifc, un id du
 * manifeste ni public (sixty5*) ni privé (private-*), ou le titre d'une maquette privée.
 */
const NAMED_ENTITIES = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&", colon: ":", sol: "/", bsol: "\\", period: "." };

/** Un tour de déséchappement (entités numériques et nommées utiles à la garde). */
function unescapeOnce(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(quot|apos|lt|gt|nbsp|amp|colon|sol|bsol|period);/gi, (_, n) => NAMED_ENTITIES[n.toLowerCase()]);
}

/** Texte déséchappé en boucle jusqu'à stabilité (au plus 5 tours : « &amp;amp;#58; » ne doit rien masquer). */
export function unescapeHtml(s) {
  let cur = String(s);
  for (let i = 0; i < 5; i++) { const next = unescapeOnce(cur); if (next === cur) break; cur = next; }
  return cur;
}

/** Forme de comparaison des titres : minuscules, sans accents (NFD puis diacritiques retirés), espaces repliés. */
const normalizeTitle = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export function assertNoLeak(html, manifest) {
  const hits = [];
  // Comparaison sur le texte déséchappé, en minuscules, antislashs ramenés à des barres obliques (un seul jeu de
  // motifs pour « \Users\x » et « /Users/x », « \\hote\x » et « //hote/x »).
  const text = unescapeHtml(html).toLowerCase().replace(/\\/g, "/");
  const paths = [
    [/(?<![a-z])[a-z]:\//, "chemin disque"], // pas \b : « x_d:/ » doit être pris ; « http:// » ne l'est pas (lettre avant)
    [/(^|[^:])\/\/[a-z0-9]/, "chemin UNC"], // « //hote/ » ; « http:// » reste permis (deux-points avant)
    [/\/mnt\//, "chemin /mnt/"], [/\/users\//, "chemin /users/"], [/\/home\//, "chemin /home/"], [/file:\/\//, "URL file://"],
  ];
  for (const [re, label] of paths) { const m = text.match(re); if (m) hits.push(`${label} ${m[0]}`); }
  const ifc = text.match(/[\w-]+\.(ifc|ifczip|ifcxml)\b/);
  if (ifc) hits.push(`fichier ${ifc[0]}`);
  const allowed = (id) => /^sixty5/.test(id) || /^private-/.test(id);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let titleText; // forme normalisée du texte, calculée à la première maquette qui a un titre
  for (const m of manifest?.models ?? []) {
    const id = String(m.id).toLowerCase();
    // Id délimité par un caractère qui n'est ni lettre ni chiffre : attrape aussi les dérivés (<id>-x2, <id>_x, x-<id>).
    // Choix assumé (arbitrage du contrôleur) : les dérivés COLLÉS à l'id (« duplex2 », « xduplex ») ne sont pas
    // attrapés ; une recherche de sous-chaîne nue donnerait des faux positifs sur des mots ordinaires.
    if (!allowed(id) && new RegExp(`(?<![a-z0-9])${esc(id)}(?![a-z0-9])`).test(text)) hits.push(`maquette ${m.id}`);
    // Titre de toute maquette non publique (alias ou non), comparé sous forme normalisée des deux côtés.
    const title = m.title ? normalizeTitle(unescapeHtml(m.title)) : "";
    if (!/^sixty5/.test(id) && title.length >= 4 && (titleText ??= normalizeTitle(text)).includes(title)) hits.push(`titre de ${m.id}`);
  }
  if (hits.length) throw new Error(`fuite : le rapport contient ${hits.join(", ")} ; rien n'est écrit`);
  return html;
}

// ---------------------------------------------------------------------------------------------------------------
// Mise en page

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = (d) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (x, d = 2) => (num(x) ? nf(d).format(x) : "—");
const fmtInt = (x) => (num(x) ? nf(0).format(Math.round(x)) : "—");
// Millisecondes → secondes : on teste AVANT de diviser (null / 1000 = 0 afficherait un faux « 0,00 s »).
const fmtSec = (ms) => (num(ms) ? `${nf(2).format(ms / 1000)} s` : "—");
const fmtPct = (frac) => (num(frac) ? `${nf(1).format(frac * 100)} %` : "—");
const sourceTag = (s) => `<small class="src">série ${escapeHtml(s ?? CHAIN_SOURCE)}</small>`;
const MIXED_NOTE = `<p class="mixed">⚠ Séries mélangées : conditions possiblement différentes. La série de chaque case est indiquée sous sa valeur.</p>`;
const DASH = "—";
const toolLabel = (t) => TOOL_LABEL[t] ?? t;
const adapterText = (a) => (a == null ? null : typeof a === "string" ? a : a.description || [a.vendor, a.architecture, a.device].filter(Boolean).join(" "));

/** Cellule d'état non chiffrée (absent, n'ouvre pas, non mesuré). */
function statusHtml(c) {
  if (!c || c.status === "missing") return `<span class="na">${DASH}</span>`;
  if (c.status === "ram") return `<span class="ko">${escapeHtml(c.note ?? "n'ouvre pas (RAM)")}</span>`;
  if (c.status === "fail") return `<span class="ko">${escapeHtml(c.note ?? "n'ouvre pas")}</span>`;
  if (c.status === "unmeasured") return `<span class="nm">non mesuré</span><small>${escapeHtml(c.note ?? "")}</small>`;
  if (c.status === "nocache") return `<span class="nm">${escapeHtml(c.note ?? "pas de cache")}</span>`; // 26/10
  return null;
}

/** Libellé d'une case connue hors liste blanche du viewer (jamais lancée) : { status, note } ou null. */
function outsideCell(tool, model, form, kit = KIT) {
  const v = VIEWERS.find((x) => x.tool === tool);
  // kit v2 : viewer non lancé sur une maquette réservée (modelTools) : hors classement, avec la raison du kit.
  if (kit?.modelTools?.[model] && !kit.modelTools[model].includes(tool)) return { status: "unmeasured", note: kit.modelToolsNote?.[model] ?? "non lancé sur cette maquette", source: "hors matrice" };
  // 26/10 : forme limitée à quelques maquettes (xeokit en IFC brut) : hors classement, avec sa raison.
  // 26/10 : le viewer qui n'ouvre pas la maquette (models / outside) passe avant la limite d'une forme.
  if (v?.models && !v.models.includes(model) && v.outside) return { status: /RAM/.test(v.outside) ? "ram" : "fail", note: v.outside, source: "hors matrice" };
  if (form && v?.formModels?.[form] && !v.formModels[form].includes(model)) return { status: "unmeasured", note: v.formOutside?.[form] ?? "forme non mesurée sur cette maquette", source: "hors matrice" };
  return null;
}

/** Résultats d'une machine → cases par axe. */
function machineCells(m, models) {
  const st = m?.journal?.status ?? {};
  const matching = (tool, form, model) => (m?.gpu ?? []).filter((r) => r.tool === tool && r.form === form && r.model === model);
  const findGpu = (tool, form, model) => matching(tool, form, model)[0] ?? null;
  // C6 : une case GPU = ses GPU_REPEATS répétitions de la chaîne (clé …/r<k>), plus une éventuelle sortie sans rep (--extra).
  const gpuOf = (machine, tool, model, form = mainFormFor(tool, "gpu")) => {
    const rs = matching(tool, form, model), base = `${machine}/gpu/${tool}/${form}/${model}`;
    const reps = [];
    // 26/10 : gpuRepeatsFor(model) passes attendues ; des passes en plus déjà mesurées (charpente-84 en 3) comptent aussi.
    const nRep = Math.max(gpuRepeatsFor(model), 1 + Math.max(-1, ...rs.map((x) => x.rep ?? -1)));
    for (let k = 0; k < nRep; k++) reps.push(gpuCell(rs.find((r) => r.rep === k) ?? null, st[`${base}/r${k}`]));
    for (const r of rs.filter((x) => x.rep == null)) reps.push(gpuCell(r, st[base]));
    const cell = gpuCellReps(reps);
    return { machine, model, tool, form, ...(cell.status === "missing" ? outsideCell(tool, model, form) ?? cell : cell) };
  };
  const openOf = (machine, tool, model, form = mainForm(tool)) => {
    const cell = openCell(m?.open ?? [], tool, model, form, st[`${machine}/open/${tool}/${form}/${model}`]);
    return { machine, model, tool, form, ...(cell.status === "missing" ? outsideCell(tool, model, form) ?? cell : cell) };
  };
  return { gpuOf, openOf, findGpu, models };
}

const AXES = [
  { id: "cold", title: "Ouverture à froid : géométrie à l'écran", unit: "s", suite: "open", metric: "coldDoneMs", hint: "médiane de 3 répétitions pour les formats convertis, une seule ouverture pour l'IFC brut (mesurée une fois), cache vide ; chiffre principal = toute la géométrie affichée, en petit = première image" },
  { id: "props", title: "Ouverture à froid : propriétés disponibles", unit: "s", suite: "open", metric: "coldPropsMs", hint: "même chargement ; instant où les propriétés sont interrogeables. That Open et xeokit les chargent dans le même appel que la géométrie (rien ne s'affiche avant) ; ifc-lite parse son modèle de données en parallèle (valeurs décodées au clic) ; Scenoptic affiche la géométrie d'abord, puis ses métadonnées (IFC brut : différées ; formats convertis : sidecars Arrow)" },
  { id: "warm", title: "Ouverture à chaud", unit: "s", suite: "open", metric: "warmDoneMs", hint: "médiane des rechargements (cache HTTP chaud), mêmes 3 répétitions ; formats convertis seulement (l'IFC brut n'est pas rechargé)" },
  { id: "gpu", title: "Fluidité : temps GPU par image sur le trajet", unit: "ms", suite: "gpu", metric: "gpuMsMed", hint: "moyenne par image sur toutes les images du trajet (médiane par pas pour les anciennes mesures) ; en petit p95 et p99 par pas, et la part d'images > 100 ms" },
  { id: "idle", title: "Repos : temps GPU par seconde à 60 Hz, caméra immobile", unit: "ms/s", suite: "gpu", metric: "idle60", hint: "travail GPU par image au repos × 60 (mesuré sans vsync, ramené à 60 Hz) ; en petit le chiffre brut et la cadence relevée (Scenoptic ne rend rien caméra immobile)" },
  { id: "cpu", title: "Processeur en mouvement : temps CPU par seconde à 60 i/s", unit: "ms/s", suite: "gpu", metric: "cpu60", hint: "temps CPU de tous les processus Chrome pendant le trajet, en ms par seconde (1 000 = un cœur plein), ramené à 60 images/s pour un viewer qui dessine plus vite (le banc tourne sans vsync) ; en petit le brut et sa cadence, le CPU par image, la page, le processus GPU (pilote compris) et le fil principal. Mesures du kit v2 seulement" },
  { id: "cpuIdle", title: "Processeur au repos : temps CPU par seconde à 60 i/s, caméra immobile", unit: "ms/s", suite: "gpu", metric: "cpuIdle60", hint: "temps CPU de tous les processus Chrome caméra immobile, ramené à 60 images/s pour un viewer qui dessine en continu ; en petit le brut. Mesures du kit v2 seulement" },
  { id: "ram", title: "RAM (pic pendant le chargement à froid)", unit: "Mo", suite: "open", metric: "ramMB", hint: "pic de mémoire privée des processus Chrome, médiane des 3 répétitions (une seule pour l'IFC brut)" },
  { id: "vram", title: "VRAM (pic pendant le chargement à froid)", unit: "Mo", suite: "open", metric: "vramMB", hint: "pic de mémoire GPU dédiée + partagée, médiane des 3 répétitions ; en petit le détail" },
];

/** C6 : nombre de répétitions et dispersion (écart max-min) d'une case GPU. */
const repsText = (c) => (c.reps == null ? "" : ` · n=${c.reps}${c.spread ? `, ${fmt(c.spread.min, 2)}–${fmt(c.spread.max, 2)} (±${fmt((c.spread.pct ?? 0) / 2, 1)} %)` : ""}`);

/** Une valeur ou « — » (jamais « — ms », jamais un faux zéro). */
const withUnit = (x, d, unit) => (num(x) ? `${fmt(x, d)} ${unit}` : DASH);

function cellHtml(axis, c, first, showSource = false) {
  const src = showSource && c && c.status !== "missing" ? sourceTag(c.source) : "";
  const s = statusHtml(c);
  if (s && c.status !== "flagged") return `${s}${src}`;
  const mark = c.status === "flagged" ? `<small class="flag">⚑ ${escapeHtml(c.note)}</small>` : "";
  let main, sub = "";
  if (axis.id === "cold") { main = fmtSec(c.coldDoneMs); sub = `1re image ${fmtSec(c.coldFirstFrameMs)}${num(c.primeMs) ? ` · amorçage ${fmtSec(c.primeMs)}` : ""}`; }
  else if (axis.id === "props") {
    if (!num(c.coldPropsMs)) main = `<span class="muted">${c.propsPolicy ? DASH : "géométrie seule"}</span>`;
    else { main = fmtSec(c.coldPropsMs); sub = c.propsPolicy === "at-done" || !num(c.coldDoneMs) || c.coldPropsMs - c.coldDoneMs < 50 ? "avec la géométrie" : `géométrie + ${fmtSec(c.coldPropsMs - c.coldDoneMs)}`; }
  }
  else if (axis.id === "warm") { main = fmtSec(c.warmDoneMs); sub = `1re image ${fmtSec(c.warmFirstFrameMs)}`; }
  else if (axis.id === "gpu") { main = withUnit(c.gpuMsMed, 2, "ms"); sub = `p95 ${fmt(c.gpuMsP95, 2)} · p99 ${fmt(c.gpuMsP99, 2)}${num(c.over100Frac) && c.over100Frac > 0 ? ` · > 100 ms ${fmtPct(c.over100Frac)}` : ""}${repsText(c)}`; }
  else if (axis.id === "idle") { main = withUnit(c.idle60, 1, "ms/s"); sub = `brut ${fmt(c.idleGpuMsPerSec, 1)} ms/s à ${fmtInt(c.idleFramesPerSec)} i/s`; }
  else if (axis.id === "cpu") { main = withUnit(c.cpu60, 0, "ms/s"); sub = num(c.cpuMsPerSec) ? `brut ${fmtInt(c.cpuMsPerSec)} ms/s à ${fmtInt(c.cpuFps)} i/s · ${fmt(c.cpuMsPerFrame, 1)} ms/image · page ${fmtInt(c.cpuRendererMsPerSec)} · GPU ${fmtInt(c.cpuGpuProcMsPerSec)} · fil principal ${fmtInt(c.cpuMainTaskMsPerSec)}` : ""; }
  else if (axis.id === "cpuIdle") { main = withUnit(c.cpuIdle60, 0, "ms/s"); sub = num(c.cpuIdleMsPerSec) ? `brut ${fmtInt(c.cpuIdleMsPerSec)} ms/s à ${fmtInt(c.idleFramesPerSec)} i/s` : ""; }
  else if (axis.id === "ram") { main = withUnit(c.ramMB, 0, "Mo"); }
  else if (axis.id === "vram") { main = withUnit(c.vramMB, 0, "Mo"); sub = `dédiée ${fmtInt(c.gpuDedMB)} · partagée ${fmtInt(c.gpuShrMB)}`; }
  const v = first && main !== DASH ? `<strong>${main}</strong>` : main;
  return `${v}${sub ? `<small>${sub}</small>` : ""}${mark}${src}`;
}

/** Séries d'origine des cases présentes (hors « — »). */
const sourcesOf = (cells) => new Set(cells.filter((c) => c && c.status !== "missing").map((c) => c.source ?? CHAIN_SOURCE));

function axisTable(axis, machine, cells, models, kind = TABLE_KINDS[0]) {
  const cols = kind.tools;
  const groups = [], all = [];
  const perModel = models.map((md) => {
    // C5a : ouverture de Scenoptic par les panes avec métadonnées ; C5c : forme du tableau (convertie ou IFC brut).
    const cs = cols.map((t) => (axis.suite === "gpu" ? cells.gpuOf(machine, t, md.id, kind.form(t, "gpu")) : cells.openOf(machine, openToolOf(t), md.id, kind.form(t, "open"))));
    all.push(...cs);
    const [g] = rankCells(cs, axis.metric, true);
    g.axis = axis.id;
    g.kind = kind.id;
    groups.push(g);
    return { md, cs, g };
  });
  const mixed = sourcesOf(all).size > 1;
  const rows = perModel.map(({ md, cs, g }) => {
    // Un seul chiffre face à des rivaux tous absents ou écartés : pas de « 1er » en gras.
    const best = g.alone ? null : g.firstPlace;
    const firstCol = g.alone ? `<span class="muted">seul mesuré</span>` : best ? `${escapeHtml(toolLabel(best))}${g.gapPct != null ? `<small>2e à +${fmt(g.gapPct, 1)} %</small>` : ""}` : `<span class="na">${DASH}</span>`;
    return `<tr><th scope="row">${escapeHtml(md.id)}</th>${cs.map((c) => `<td>${cellHtml(axis, c, c.tool === best, mixed)}</td>`).join("")}<td class="win">${firstCol}</td></tr>`;
  });
  const html = `${mixed ? MIXED_NOTE : ""}<div class="tw"><table><thead><tr><th scope="col">Maquette</th>${cols.map((t) => `<th scope="col">${escapeHtml(toolLabel(t))}</th>`).join("")}<th scope="col">1er</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  return { html, groups, mixed };
}

/** Lignes secondaires : Lambert (GPU), affichées seulement si des mesures existent (l'IFC brut a son propre tableau, C5c). */
function secondaryTable(machine, cells, models) {
  const specs = [
    { tool: "scenoptic-webgpu-rb-lambert", form: "sgpun", suite: "gpu", axis: AXES.find((a) => a.id === "gpu") },
  ];
  const lines = [];
  for (const s of specs) for (const md of models) {
    const c = s.suite === "gpu" ? cells.gpuOf(machine, s.tool, md.id, s.form) : cells.openOf(machine, s.tool, md.id, s.form);
    if (c.status === "missing") continue;
    lines.push(`<tr><th scope="row">${escapeHtml(s.label ?? toolLabel(s.tool))}</th><td>${escapeHtml(md.id)}</td><td>${escapeHtml(s.axis.title)}</td><td>${cellHtml(s.axis, c, false, true)}</td></tr>`);
  }
  if (!lines.length) return `<p class="muted">Aucune mesure secondaire (Lambert) sur cette machine pour l'instant.</p>`;
  return `<div class="tw"><table><thead><tr><th scope="col">Ligne</th><th scope="col">Maquette</th><th scope="col">Axe</th><th scope="col">Valeur</th></tr></thead><tbody>${lines.join("")}</tbody></table></div>`;
}

function effectsTable(machine, cells, models) {
  const all = [];
  const rows = models.map((md) => {
    const tds = FX_PAIRS.map(([g, f]) => {
      const geo = cells.gpuOf(machine, g, md.id), fx = cells.gpuOf(machine, f, md.id);
      all.push(geo, fx);
      const cost = effectsCost(geo, fx);
      if (!cost) {
        const why = geo.status !== "ok" && geo.status !== "missing" ? `géométrie : ${statusHtml(geo) ?? escapeHtml(geo.note)}` : fx.status !== "ok" && fx.status !== "missing" ? `effets : ${statusHtml(fx) ?? escapeHtml(fx.note)}` : "";
        return `<td><span class="na">${DASH}</span>${why ? `<small>${why}</small>` : ""}</td>`;
      }
      const sign = (x) => (x > 0 ? "+" : "");
      // Géométrie et effets de deux séries différentes : l'écart mélange deux conditions, on le dit.
      const split = (geo.source ?? CHAIN_SOURCE) !== (fx.source ?? CHAIN_SOURCE)
        ? `<small class="flag">⚠ séries différentes : géométrie ${escapeHtml(geo.source ?? CHAIN_SOURCE)}, effets ${escapeHtml(fx.source ?? CHAIN_SOURCE)}</small>` : "";
      return `<td>${sign(cost.ms)}${fmt(cost.ms, 2)} ms<small>${cost.pct == null ? "" : `${sign(cost.pct)}${fmt(cost.pct, 1)} % · `}${fmt(geo.gpuMsMed, 2)} → ${fmt(fx.gpuMsMed, 2)} ms</small>${split}</td>`;
    });
    return `<tr><th scope="row">${escapeHtml(md.id)}</th>${tds.join("")}</tr>`;
  });
  return `${sourcesOf(all).size > 1 ? MIXED_NOTE : ""}<div class="tw"><table><thead><tr><th scope="col">Maquette</th>${FX_PAIRS.map(([g, f]) => `<th scope="col">${escapeHtml(toolLabel(g))}<small>→ ${escapeHtml(toolLabel(f))}</small></th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const yesNo = (v) => (v === true ? "oui" : v === false ? "non" : v == null ? DASH : String(v));

// Revue finale, imp. 7 : intentions du plan, comparées à ce que les sorties relèvent.
export const POST_INTENT = { thatopen: "off", "thatopen-webgpu": "off", "thatopen-fx-composer": "composer", "thatopen-fx-deferred": "deferred", "thatopen-webgpu-fx": "webgpu-tsl" };
export const AA_INTENT = { thatopen: "MSAA 4×", "thatopen-fx-composer": "MSAA 4×", "thatopen-fx-deferred": "MSAA 4×", "scenoptic-rb": "MSAA 4×", "scenoptic-rb-fx": "MSAA 4×", "thatopen-webgpu": "aucun", "thatopen-webgpu-fx": "aucun", "scenoptic-webgpu-rb": "SMAA", "scenoptic-webgpu-rb-fx": "SMAA", "scenoptic-webgpu-rb-lambert": "SMAA", "scenoptic-webgpu-rb-fx-lambert": "SMAA" };

/** Anticrénelage relevé dans une sortie de sonde : MSAA (contexte WebGL, textures multi-échantillonnées WebGPU), SMAA / FXAA (passes). */
export function aaOf(r) {
  const out = [];
  const gl = Math.max(0, ...(r?.aa?.webgl ?? []).map((g) => (num(g.samples) ? g.samples : 0)));
  const gpu = r?.aa?.webgpu;
  const msaa = Math.max(gl, gpu && gpu.resolvePasses > 0 && num(gpu.maxSampleCount) ? gpu.maxSampleCount : 0);
  if (msaa > 1) out.push(`MSAA ${msaa}×`);
  const labels = (r?.passLabels ?? []).join(" ");
  if (/smaa/i.test(labels)) out.push("SMAA");
  if (/fxaa/i.test(labels)) out.push("FXAA");
  if (out.length) return out.join(" + ");
  return r?.aa ? "aucun" : null;
}
/** Post / effets relevés contre l'intention : { intent, measured, deviates }. */
export function postOf(r) {
  if (r?.info?.tocLive || r?.info?.extra?.toc) { const t = r.info.tocLive ?? r.info.extra.toc; const intent = POST_INTENT[r.tool] ?? null; return { intent, measured: t.post ?? null, deviates: intent != null && t.post !== intent }; }
  if (r?.rebench) { const fx = /-fx(-|$)/.test(r.tool); const measured = `AO ${yesNo(r.rebench.ao)}, arêtes ${yesNo(r.rebench.edges)}`; return { intent: `AO ${yesNo(fx)}, arêtes ${yesNo(fx)}`, measured, deviates: r.rebench.ao !== fx || r.rebench.edges !== fx }; }
  return null;
}

/** Conditions relevées d'une machine : versions, adaptateurs, alimentation, réglages coupés observés. */
function conditionsHtml(machine, m) {
  const results = [...(m?.gpu ?? [])];
  // Une ligne par (pane, série) : versions et adaptateurs d'une série ne se mélangent pas avec ceux d'une autre.
  const byTool = new Map();
  const note = (r, key, v) => {
    if (v == null || v === "") return;
    const source = r.__source ?? CHAIN_SOURCE, k = `${r.tool}\u0000${source}`;
    if (!byTool.has(k)) byTool.set(k, { tool: r.tool, source, versions: new Set(), adapters: new Set(), conversions: new Set(), aa: new Set(), settings: new Map(), post: new Map() });
    const e = byTool.get(k);
    if (key === "settings" || key === "post") e[key].set(JSON.stringify(v), v); else e[key].add(v);
  };
  for (const r of results) {
    note(r, "versions", r.version);
    note(r, "adapters", adapterText(r.adapter));
    if (r.conversion?.versions) note(r, "conversions", Object.values(r.conversion.versions).filter(Boolean).join(", ") || null);
    if (r.rebench) note(r, "settings", { kind: "sceno", profile: r.rebench.profile, boost: r.rebench.boost, governor: r.rebench.governor, restSupersample: r.rebench.restSupersample, shading: r.rebench.shading, ao: r.rebench.ao, edges: r.rebench.edges });
    const toc = r.info?.tocLive;
    // Imp. 7 : movingResolution LU par readToc (objet { enabled, scale… } de components-front 3.6) ; « non relevé » si absent.
    if (toc) note(r, "settings", { kind: "toc", adaptiveResolution: toc.adaptiveResolution, movingResolution: "movingResolution" in toc ? toc.movingResolution : undefined, turnOffOnManualMode: toc.turnOffOnManualMode, post: toc.post, style: toc.style, mode: toc.mode });
    const aa = aaOf(r); if (aa) note(r, "aa", aa);
    const po = postOf(r); if (po) note(r, "post", po);
  }
  const primes = new Map(); // 26/10 : (ligne, maquette) → temps d'amorçage du cache ifc-lite (passe 0 de chaque répétition)
  for (const r of m?.open ?? []) {
    note(r, "versions", r.version); note(r, "adapters", r.gpu?.webgl?.renderer ? `WebGL : ${r.gpu.webgl.renderer}` : null);
    if (r.primed) {
      if ((r.pass ?? 0) !== 0 || !num(r.conversion?.ms)) continue;
      const k = `${r.tool}\u0000${r.__source ?? CHAIN_SOURCE}\u0000${r.model}\u0000${r.conversion.tier ?? ""}`;
      primes.set(k, [...(primes.get(k) ?? []), r]);
    } else note(r, "conversions", r.conversion?.version ?? null);
  }
  for (const rs of primes.values()) {
    const r = rs[0];
    note(r, "conversions", `${r.conversion.tool} : ${r.model}, amorçage ${fmtSec(median(rs.map((x) => x.conversion.ms)))} (méd. ${rs.length}), palier ${r.conversion.tier ?? DASH}${num(r.conversion.cacheBytes) ? `, ${fmt(r.conversion.cacheBytes / 1e6, 0)} Mo` : ""}`);
  }
  const order = Object.keys(TOOL_LABEL);
  const keys = [...byTool.keys()].sort((a, b) => { const x = byTool.get(a), y = byTool.get(b); return order.indexOf(x.tool) - order.indexOf(y.tool) || x.source.localeCompare(y.source); });
  const mixed = new Set([...byTool.values()].map((e) => e.source)).size > 1;
  const settingText = (s) => s.kind === "sceno"
    ? `profil ${escapeHtml(s.profile ?? DASH)}, boost ${yesNo(s.boost)}, gouverneur ${yesNo(s.governor)}, suréch. repos ${escapeHtml(s.restSupersample ?? DASH)}${s.shading ? `, ombrage ${escapeHtml(s.shading)}` : ""}${s.ao || s.edges ? `, AO ${yesNo(s.ao)}, arêtes ${yesNo(s.edges)}` : ""}`
    : `adaptiveResolution ${yesNo(s.adaptiveResolution)}, movingResolution ${s.movingResolution === undefined ? "non relevé (pane d'avant la revue finale)" : s.movingResolution === null ? "absent de la bibliothèque" : `${s.movingResolution.enabled ? "activé" : "désactivé"}${s.movingResolution.enabled ? ` (échelle ${escapeHtml(s.movingResolution.scale)})` : ""}`}, turnOffOnManualMode ${yesNo(s.turnOffOnManualMode)}, post ${escapeHtml(s.post ?? DASH)}${s.post && s.post !== "off" ? ` (style ${escapeHtml(s.style)}, mode ${escapeHtml(s.mode)})` : ""}`;
  // Écart aux réglages imposés (on le signale, on ne le corrige pas).
  const deviates = (s) => (s.kind === "sceno" ? s.profile !== "normal" || s.boost !== false || s.governor !== false || s.restSupersample !== 1 : s.adaptiveResolution !== false || s.turnOffOnManualMode !== false || s.movingResolution?.enabled === true);
  const aaCell = (e) => { const got = [...e.aa]; const want = AA_INTENT[e.tool]; const off = want && got.length && got.some((x) => x !== want);
    return got.length ? `${got.map(escapeHtml).join("<br>")}${want ? `<small>intention ${escapeHtml(want)}</small>` : ""}${off ? ` <span class="ko">écart intention / mesure</span>` : ""}` : DASH; };
  const postCell = (e) => { const ps = [...e.post.values()]; return ps.length ? ps.map((p) => `${escapeHtml(p.measured ?? DASH)}<small>intention ${escapeHtml(p.intent ?? DASH)}</small>${p.deviates ? ` <span class="ko">écart intention / mesure</span>` : ""}`).join("<br>") : DASH; };
  const rows = keys.map((k) => {
    const e = byTool.get(k);
    const set = [...e.settings.values()];
    return `<tr><th scope="row">${escapeHtml(toolLabel(e.tool))}</th><td>${escapeHtml(e.source)}</td><td>${[...e.versions].map(escapeHtml).join("<br>") || DASH}</td><td>${[...e.conversions].map(escapeHtml).join("<br>") || DASH}</td><td>${[...e.adapters].map(escapeHtml).join("<br>") || DASH}</td><td>${set.map((s) => `${settingText(s)}${deviates(s) ? ` <span class="ko">écart aux réglages imposés</span>` : ""}`).join("<br>") || DASH}</td><td>${aaCell(e)}</td><td>${postCell(e)}</td></tr>`;
  });
  const schemes = new Set(results.map((r) => r.power?.scheme).filter(Boolean));
  for (const l of m?.journal?.header ?? []) { const p = l.match(/^# powercfg : (.+)$/); if (p) schemes.add(p[1]); }
  const nvLines = results.flatMap((r) => r.power?.nvidia ?? []).filter(Boolean);
  const watts = nvLines.map((l) => Number(l.match(/([\d.]+)\s*W\s*$/)?.[1])).filter(num);
  const nv = new Set(nvLines.map((l) => l.replace(/,?\s*[\d.]+\s*W\s*$/, "").replace(/,\s*\[N\/A\]/, "")));
  if (watts.length) nv.add(`puissance au début des cases : ${fmt(Math.min(...watts), 1)} à ${fmt(Math.max(...watts), 1)} W (${watts.length} cases)`);
  // C1 : fréquences relevées PENDANT le trajet (nvidia-smi -lms 200), médianes des cases : min et max entre cases.
  const smi = results.map((r) => r.smi).filter((x) => x && x.relevant !== false); // relevé NVIDIA d'une case iGPU : écarté
  const range = (xs, d = 0) => (xs.length ? `${fmt(Math.min(...xs), d)} à ${fmt(Math.max(...xs), d)}` : DASH);
  if (smi.length) nv.add(`pendant le trajet (${smi.length} cases) : clocks.gr méd ${range(smi.map((x) => x.clocksGrMHz?.med).filter(num))} MHz (min ${range(smi.map((x) => x.clocksGrMHz?.min).filter(num))}), clocks.mem méd ${range(smi.map((x) => x.clocksMemMHz?.med).filter(num))} MHz, power méd ${range(smi.map((x) => x.powerW?.med).filter(num), 1)} W`);
  const cad = results.map((r) => r.cadence).filter(Boolean);
  const cadText = cad.length ? `${fmt(cad[0].stepMs, 1)} ms par pas d'horloge ; dépassements ${range(cad.map((c) => (c.overrunFrac ?? 0) * 100), 1)} % des pas selon la case` : DASH;
  const canvases = new Set(results.map((r) => r.camera?.canvas && `${r.camera.canvas.w}×${r.camera.canvas.h}`).filter(Boolean));
  return `<dl class="kv">
    <dt>Alimentation (powercfg)</dt><dd>${[...schemes].map(escapeHtml).join("<br>") || DASH}</dd>
    <dt>GPU (nvidia-smi, début de case)</dt><dd>${[...nv].map(escapeHtml).join("<br>") || DASH}</dd>
    <dt>Cadence du trajet</dt><dd>${escapeHtml(cadText)}</dd>
    <dt>Canevas relevé</dt><dd>${[...canvases].join(", ") || DASH} (fenêtre Chrome 1280×800)</dd>
  </dl>
  ${mixed ? MIXED_NOTE : ""}${rows.length ? `<div class="tw"><table><thead><tr><th scope="col">Ligne</th><th scope="col">Série</th><th scope="col">Version</th><th scope="col">Conversion</th><th scope="col">Adaptateur du viewer</th><th scope="col">Réglages relevés</th><th scope="col">Anticrénelage relevé</th><th scope="col">Post / effets relevés</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="muted">Aucune mesure sur cette machine pour l'instant.</p>`}`;
}

function shotsHtml(shots) {
  if (!shots?.length) return `<p class="muted">Aucune capture disponible.</p>`;
  const out = [];
  const keys = [...new Set(shots.map((s) => `${s.machine}\u0000${s.model}`))];
  for (const k of keys) {
    const [machine, model] = k.split("\u0000");
    const mine = shots.filter((s) => s.machine === machine && s.model === model);
    const tools = SHOT_TOOLS.filter((t) => mine.some((s) => s.tool === t));
    const vps = [...new Set(mine.map((s) => s.vp))].sort();
    const head = `<tr><th scope="col">Point de vue</th>${tools.map((t) => `<th scope="col">${escapeHtml(toolLabel(t))}</th>`).join("")}</tr>`;
    const body = vps.map((vp) => `<tr><th scope="row">${escapeHtml(vp)}</th>${tools.map((t) => { const s = mine.find((x) => x.tool === t && x.vp === vp); return `<td>${s ? `<a href="${escapeHtml(s.href)}"><img loading="lazy" src="${escapeHtml(s.href)}" alt="${escapeHtml(`${toolLabel(t)}, ${model}, ${vp}`)}"></a>` : `<span class="na">${DASH}</span>`}</td>`; }).join("")}</tr>`).join("");
    out.push(`<h3>${escapeHtml(model)} — ${escapeHtml(MACHINE_LABEL[machine] ?? machine)}</h3><div class="tw shots"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`);
  }
  return out.join("");
}

function lossesHtml(list, excluded = []) {
  const kindTitle = (k) => TABLE_KINDS.find((x) => x.id === k)?.title;
  const axisTitle = (id, kind) => `${AXES.find((a) => a.id === id)?.title ?? id}${kind && kindTitle(kind) ? ` — ${kindTitle(kind)}` : ""}`;
  const unit = (id) => AXES.find((a) => a.id === id)?.unit ?? "";
  const val = (l, v) => (l.axis === "cold" || l.axis === "warm" ? fmtSec(v) : withUnit(v, 2, unit(l.axis)));
  const src = (s) => escapeHtml(s ?? CHAIN_SOURCE);
  const lossPart = !list.length
    ? `<p>Aucune case perdue sur les mesures disponibles. Une case ne compte que si Scenoptic et au moins un concurrent y ont un chiffre fiable.</p>`
    : `<div class="tw"><table><thead><tr><th scope="col">Axe</th><th scope="col">Machine</th><th scope="col">Maquette</th><th scope="col">Scenoptic</th><th scope="col">Meilleur concurrent</th><th scope="col">Retard</th><th scope="col">Séries</th></tr></thead><tbody>${list.map((l) => {
      const same = (l.source ?? CHAIN_SOURCE) === (l.winnerSource ?? CHAIN_SOURCE);
      return `<tr><td>${escapeHtml(axisTitle(l.axis, l.kind))}</td><td>${escapeHtml(MACHINE_LABEL[l.machine] ?? l.machine)}</td><td>${escapeHtml(l.model)}</td><td>${escapeHtml(toolLabel(l.tool))}<small>${l.failed ? "n'ouvre pas" : val(l, l.value)}</small>${sourceTag(l.source)}</td><td>${escapeHtml(toolLabel(l.winner))}<small>${val(l, l.winnerValue)}</small>${l.winnerFlag ? `<small class="flag">⚑ ${escapeHtml(l.winnerFlag)}</small>` : ""}${sourceTag(l.winnerSource)}</td><td>${l.gapPct == null ? DASH : `+${fmt(l.gapPct, 1)} %`}</td><td>${same ? src(l.source) : `<span class="flag">Scenoptic ${src(l.source)}, concurrent ${src(l.winnerSource)} : séries mélangées</span>`}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  const exclPart = !excluded.length ? "" : `<h3>Écartées du classement</h3><p class="hint">Cases présentes mais hors classement, tous viewers : elles ne comptent ni comme gagnées ni comme perdues. Un concurrent marqué (⚑) reste classé ; une case Scenoptic marquée est écartée.</p><ul>${excluded.map((e) => `<li>${escapeHtml(axisTitle(e.axis, e.kind))}, ${escapeHtml(MACHINE_LABEL[e.machine] ?? e.machine)}, ${escapeHtml(e.model)}, ${escapeHtml(toolLabel(e.tool))} (série ${src(e.source)}) : écartée du classement : ${escapeHtml(e.status === "unmeasured" ? `non mesuré, ${e.note ?? ""}` : e.note ?? "marquée")}</li>`).join("")}</ul>`;
  return lossPart + exclPart;
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1f21;--muted:#5d646b;--line:#d9dcdf;--head:#f0f1f2;--accent:#0f7b6c;--ko:#b3261e;--nm:#8a5a00;--card:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151719;--fg:#e6e8ea;--muted:#9aa3ab;--line:#33383d;--head:#1f2326;--accent:#4fd1b5;--ko:#ff8a80;--nm:#f2c46d;--card:#1b1e21}}
:root[data-theme="dark"]{--bg:#151719;--fg:#e6e8ea;--muted:#9aa3ab;--line:#33383d;--head:#1f2326;--accent:#4fd1b5;--ko:#ff8a80;--nm:#f2c46d;--card:#1b1e21}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:1rem;margin:24px 0 6px}h4{font-size:.92rem;margin:14px 0 4px;color:var(--muted)}
p,li{max-width:75ch}.muted,.hint{color:var(--muted)}.hint{font-size:.9rem;margin:0 0 8px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:6px;background:var(--card);margin:8px 0 16px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
thead th{background:var(--head);font-weight:600;font-size:.85rem}tbody tr:last-child>*{border-bottom:0}
td small,th small{display:block;color:var(--muted);font-size:.78rem;font-weight:400}
strong{color:var(--accent)}.na{color:var(--muted)}.ko{color:var(--ko)}.nm{color:var(--nm)}.flag{color:var(--nm)!important}
td.win{font-weight:600}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.note{border-left:3px solid var(--accent);padding:4px 12px;margin:8px 0;background:var(--card)}
.mixed{border-left:3px solid var(--nm);padding:4px 12px;margin:8px 0;background:var(--card);color:var(--nm);font-weight:600}
.shots img{width:220px;height:auto;display:block;border-radius:3px}
nav ul{display:flex;flex-wrap:wrap;gap:4px 14px;padding:0;list-style:none;margin:12px 0}nav a{color:var(--accent)}
@media (max-width:600px){body{font-size:14px}.kv{grid-template-columns:1fr}.kv dt{margin-top:6px}.shots img{width:150px}}
`;

/**
 * Page complète. data = { machines: { "4090"|"igpu": { gpu: Result[], open: Run[], journal: { header: string[], status: {key: STATUT} } } | null },
 *   models: models.json, shots: [{ machine, model, tool, form, vp, href }], generated?: string }.
 */
export function renderReport(data) {
  const models = (data.models ?? []).map((m) => ({ ...m, public: m.public ?? /^sixty5/.test(m.id) }));
  // local (kit portable) : machines du kit (kit-import.mjs) après 4090 et igpu ; sans elles, rien ne change.
  const machines = [...MACHINES, ...Object.keys(data.machines ?? {}).filter((k) => !MACHINES.includes(k)).sort()].filter((k) => k in (data.machines ?? {}));
  const allGroups = [];
  const sections = [];
  for (const mk of machines) {
    const m = data.machines[mk];
    if (!m) { sections.push(`<h2 id="m-${mk}">${escapeHtml(MACHINE_LABEL[mk] ?? mk)}</h2><p class="muted">Série pas encore mesurée sur cette machine : toutes ses cases sont « — ».</p>`); continue; }
    const cells = machineCells(m, models);
    const parts = [];
    for (const axis of AXES) {
      const sub = TABLE_KINDS.map((kind) => {
        const { html, groups } = axisTable(axis, mk, cells, models, kind);
        allGroups.push(...groups);
        const after = kind.id === "conv" && kind.tools.includes("ifclite") ? `<p class="hint">${escapeHtml(axis.suite === "gpu" ? CACHE_GPU_NOTE : CACHE_NOTE)}</p>` : ""; // 26/10
        return `<h4 id="${axis.id}-${kind.id}-${mk}">${escapeHtml(kind.title)}</h4>${kind.id === "ifc" && axis.suite === "gpu" ? `<p class="hint">IFC brut en fluidité et au repos : Sixty5 seulement.</p>` : ""}${html}${after}`;
      });
      parts.push(`<h3 id="${axis.id}-${mk}">${escapeHtml(axis.title)}</h3><p class="hint">${escapeHtml(axis.hint)}. Deux classements : format converti (forme principale de chaque viewer) et IFC brut. Le 1er de chaque ligne est en gras ; ⚑ = case marquée.</p>${sub.join("")}`);
    }
    parts.push(`<h3 id="fx-${mk}">Coût des effets (temps GPU médian par image)</h3><p class="hint">Écart entre le pane d'effets et son pane de géométrie seule, même trajet. Chez TOC : postproduction activée, style COLOR_PEN_SHADOWS, modes COMPOSER et DEFERRED en WebGL, composition TSL en WebGPU.</p>${effectsTable(mk, cells, models)}`);
    parts.push(`<h3>Lignes secondaires</h3>${secondaryTable(mk, cells, models)}`);
    const series = new Set([...(m.gpu ?? []), ...(m.open ?? [])].map((r) => r.__source ?? CHAIN_SOURCE));
    sections.push(`<h2 id="m-${mk}">${escapeHtml(MACHINE_LABEL[mk] ?? mk)}</h2>${series.size > 1 ? MIXED_NOTE.replace("</p>", ` Séries présentes : ${[...series].map(escapeHtml).join(", ")}.</p>`) : ""}${parts.join("")}`);
  }
  const lossList = losses(allGroups);
  const condSections = machines.map((mk) => `<h3>${escapeHtml(MACHINE_LABEL[mk] ?? mk)}</h3>${conditionsHtml(mk, data.machines[mk])}`).join("");
  const modelRows = models.map((m) => `<tr><th scope="row">${escapeHtml(m.id)}</th><td>${m.public ? "publique" : "confidentielle (alias)"}</td><td>${num(m.ifcBytes) ? `${fmt(m.ifcBytes / 1e6, 0)} Mo` : DASH}</td><td>${fmtInt(m.triangles)}</td><td>${fmtInt(m.objects)}</td></tr>`).join("");
  const toc = [["conditions", "Conditions"], ["maquettes", "Maquettes"], ...machines.map((k) => [`m-${k}`, MACHINE_LABEL[k] ?? k]), ["pertes", "Où on perd"], ["captures", "Captures"]];

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rebench viewers IFC</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Rebench viewers IFC web</h1>
<p class="muted">Scenoptic face à That Open 3.6 (WebGL et WebGPU), ifc-lite, BIM Open Viewer et xeokit. Généré le ${escapeHtml(data.generated ?? new Date().toISOString().slice(0, 10))}. Une case « — » n'a pas encore été mesurée.</p>
<nav><ul>${toc.map(([id, t]) => `<li><a href="#${id}">${escapeHtml(t)}</a></li>`).join("")}</ul></nav>

<h2 id="conditions">Conditions</h2>
<ul>
<li>Chrome headless, fenêtre 1280×800, sans vsync ni plafond d'images. Les séries RTX 4090 et iGPU ne sont jamais mélangées : l'adaptateur réel du viewer est relevé à chaque case.</li>
<li>Fluidité = temps GPU par image : timer query autour de chaque rappel rAF en WebGL, <code>timestampWrites</code> sur chaque passe en WebGPU. Sans chiffre GPU fiable, la case affiche « non mesuré », jamais l'intervalle rAF.</li>
<li>Réglages coupés chez Scenoptic : profil Normal fixe (jamais Auto), boost coupé (WebGL et WebGPU), gouverneur d'images coupé, suréchantillonnage au repos forcé à 1, pour comparer à la même résolution que That Open.</li>
<li>Réglages coupés chez That Open : <code>adaptiveResolution</code> désactivé, <code>turnOffOnManualMode</code> à false, <code>cssSize</code> par défaut. <code>movingResolution</code> (WebGPU, components-front 3.6) est relu sur le renderer : voir la colonne « Réglages relevés ».</li>
<li>Anticrénelage et post-production : relevés dans les sorties de chaque case (contexte WebGL, textures multi-échantillonnées et passes WebGPU, état de la postproduction), comparés à l'intention du plan dans le tableau des conditions ; un écart y est signalé.</li>
<li>Fluidité : un pas de trajet toutes les 33,3 ms d'horloge (30 Hz) pour tous les viewers (mêmes 601 poses sur 20 s ; témoin à 60 Hz sur une maquette), image du pas attendue, pas de rattrapage ; fréquences GPU relevées pendant le trajet. Chaque case est la médiane de 3 répétitions alternées, avec leur dispersion.</li>
<li>Ouverture et RAM : Scenoptic ouvre ses métadonnées (sidecars Arrow, propriétés IFC) comme That Open, dont le .frag porte les propriétés. La RAM est le pic du chargement et de l'après-chargement.</li>
<li>Scenoptic ne rend rien caméra immobile : son temps GPU au repos est nul par construction.</li>
<li>Formes : Scenoptic WebGPU lit ses fichiers de production sans normales, Scenoptic WebGL son format tuilé, That Open ses fragments, xeokit son .xkt, ifc-lite le cache IndexedDB de son viewer (géométrie et modèle de données de l'IFC déjà calculés, construits à une ouverture d'amorçage non comptée dans le même profil Chrome ; profil rouvert sans cache HTTP ni cache de shaders). Le tableau « IFC brut » lit l'IFC dans le navigateur, sans cache.</li>
</ul>
<p class="note"><strong>Note.</strong> Le pane That Open WebGPU contient un correctif local du bug « instanceCount infini » de fragments 3.6 en WebGPU. Sans lui, la maquette est incomplète sans post-production et l'image est noire avec la composition TSL.</p>
${condSections}

<h2 id="maquettes">Maquettes</h2>
<p class="hint">Les maquettes confidentielles n'apparaissent que sous alias, avec poids, triangles et objets, sans capture.</p>
<div class="tw"><table><thead><tr><th scope="col">Maquette</th><th scope="col">Statut</th><th scope="col">Poids de l'IFC</th><th scope="col">Triangles</th><th scope="col">Objets</th></tr></thead><tbody>${modelRows}</tbody></table></div>

${sections.join("\n")}

<h2 id="pertes">Où on perd</h2>
<p class="hint">Cases où un concurrent fait mieux qu'un pane Scenoptic, tous axes, machines et classements (format converti et IFC brut) confondus, avec le retard de Scenoptic sur le meilleur concurrent.</p>
${lossesHtml(lossList, excludedCells(allGroups))}

<h2 id="captures">Captures</h2>
<p class="hint">Sixty5 et ses matrices seulement, 11 points de vue du trajet, géométrie seule et effets, Scenoptic contre That Open.</p>
${shotsHtml(data.shots)}
</main>
</body>
</html>
`;
}

export { shotsAllowed };

// ---------------------------------------------------------------------------------------------------------------
// local (kit portable) : machine importée d'un kit (scripts/kit-import.mjs) dont kit.json remplace des formes
// (ex. scenoptic-webgpu-rb en sgpuq au lieu de sgpun). Le rapport range ses cases dans la colonne de la forme de la
// matrice (r.kitForm garde la forme réellement mesurée) ; sans kit.json, rien ne change.

/** Correspondance tool → (forme du kit → forme de la matrice), position par position dans la liste des formes. */
export function kitFormAlias(kit) {
  const alias = new Map();
  for (const [tool, forms] of Object.entries(kit?.forms ?? {})) {
    const v = VIEWERS.find((x) => x.tool === tool);
    if (!v || !Array.isArray(forms)) continue;
    const m = new Map();
    forms.forEach((f, i) => { if (v.forms[i] && f !== v.forms[i]) m.set(f, v.forms[i]); });
    if (m.size) alias.set(tool, m);
  }
  return alias;
}

/** Applique kitFormAlias aux résultats d'une machine ({ gpu, open, journal }) ; renvoie les lignes « forme du kit → colonne ». */
export function applyKitFormAlias(m, alias) {
  const used = new Set();
  const fix = (r) => { const to = alias.get(r?.tool)?.get(r.form); if (to) { used.add(`${r.tool} : ${r.form} → colonne ${to}`); r.kitForm = r.form; r.form = to; } };
  for (const r of m.gpu ?? []) fix(r);
  for (const r of m.open ?? []) fix(r);
  if (m.journal?.status) {
    const st = {};
    for (const [k, s] of Object.entries(m.journal.status)) { const p = k.split("/"); const to = alias.get(p[2])?.get(p[3]); if (to) p[3] = to; st[p.join("/")] = s; }
    m.journal.status = st;
  }
  return [...used].sort();
}
