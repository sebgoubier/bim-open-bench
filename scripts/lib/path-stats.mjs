// LOCAL ONLY (rebench tâche 5) : statistiques du trajet de caméra pour scripts/gpu-path-probe.mjs.

/** Valeur au rang le plus proche (rang = ceil(p × n), 1-indexé) d'une liste déjà triée ; liste vide ⟹ null. */
function nearestRank(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

/** Médiane (rang le plus proche) des valeurs non nulles ; liste vide ⟹ null. */
function median(values) {
  const s = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return nearestRank(s, 0.5);
}

/**
 * Résumé des durées d'image (ms) du trajet : médiane, p95 et p99 par la méthode du rang le plus proche,
 * nombre d'images de plus de 100 ms. La liste d'entrée n'est pas modifiée.
 * @param {number[]} frameMs
 * @returns {{ med: number|null, p95: number|null, p99: number|null, over100: number }}
 */
export function pathSummary(frameMs) {
  const s = frameMs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return { med: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), p99: nearestRank(s, 0.99), over100: s.filter((x) => x > 100).length };
}

/**
 * Rapports mouvement / repos des poses appariées (restTris[i] et moveTris[i] relevés au même instant du trajet) ; seules
 * les paires complètes et un repos > 0 comptent.
 */
export function boostRatios(restTris, moveTris) {
  const out = [];
  for (let i = 0; i < Math.min(restTris.length, moveTris.length); i++) {
    const r = restTris[i], m = moveTris[i];
    if (r == null || m == null || !Number.isFinite(r) || !Number.isFinite(m) || !(r > 0)) continue;
    out.push(m / r);
  }
  return out;
}

/**
 * Boost de mouvement suspect (revue finale C2, critère durci) : aux mêmes poses, la médiane des rapports
 * mouvement / repos est < 0,9, OU une pose a un rapport < 0,7. Aucune paire ⟹ faux.
 * (Avant : médiane des triangles en mouvement < 0,7 × médiane au repos, aveugle à 9 poses sur 11 à 0,5-0,75.)
 * @param {number[]} restTris
 * @param {number[]} moveTris
 */
export function boostSuspect(restTris, moveTris) {
  const q = boostRatios(restTris, moveTris);
  if (!q.length) return false;
  return median(q) < 0.9 || Math.min(...q) < 0.7;
}

/**
 * Une durée GPU par pas de caméra : pour le pas i, la PREMIÈRE image avec travail dont la clé est > stepStarts[i] et
 * ≤ stepStarts[i + 1] (dernier pas : sans borne haute) ; aucune ⟹ null. Les images rendues ensuite à la même pose
 * (attente du GPU, viewer qui dessine à chaque tick) sont ignorées : chaque pas pèse une image, quel que soit le viewer.
 * Clé = horodatage rAF (WebGL, début du pas en performance.now()) ou numéro d'image de __gpuW (WebGPU, dernier numéro
 * vu au début du pas).
 * @param {number[]} stepStarts croissants
 * @param {{ key: number, ms: number }[]} frames
 * @returns {(number|null)[]}
 */
export function perStepFrames(stepStarts, frames) {
  const f = frames.filter((x) => x && x.ms > 0).slice().sort((a, b) => a.key - b.key);
  const out = [];
  let j = 0;
  for (let i = 0; i < stepStarts.length; i++) {
    const lo = stepStarts[i], hi = i + 1 < stepStarts.length ? stepStarts[i + 1] : Infinity;
    while (j < f.length && f[j].key <= lo) j++;
    out.push(j < f.length && f[j].key <= hi ? f[j].ms : null);
  }
  return out;
}

/**
 * Verdict du contrôle de boost : « vérifié » seulement avec un capteur PAR IMAGE (triangles réellement dessinés) et au
 * moins 3 poses appariées ; sinon checked = false et la raison (« capteur invariant » : total chargé, pas un relevé par
 * image ; « pas de paires »). suspect n'a de sens que si checked.
 * @returns {{ checked: boolean, suspect: boolean, pairs: number, reason: string|null }}
 */
export function boostVerdict(restTris, moveTris, perFrameSensor) {
  let pairs = 0;
  for (let i = 0; i < Math.min(restTris.length, moveTris.length); i++) if (Number.isFinite(restTris[i]) && Number.isFinite(moveTris[i])) pairs++;
  if (!perFrameSensor) return { checked: false, suspect: false, pairs, reason: "capteur invariant (pas un relevé par image)" };
  if (pairs < 3) return { checked: false, suspect: false, pairs, reason: `pas de paires (${pairs} < 3)` };
  return { checked: true, suspect: boostSuspect(restTris, moveTris), pairs, reason: null };
}

/**
 * Travail GPU par seconde (ms/s) sur une fenêtre de windowMs : somme des durées d'image / durée de la fenêtre.
 * Fenêtre nulle ou négative ⟹ null ; aucune image ⟹ 0 (viewer qui ne dessine rien au repos).
 */
export function gpuMsPerSecond(frameMs, windowMs) {
  if (!(windowMs > 0)) return null;
  const sum = frameMs.filter((x) => Number.isFinite(x) && x > 0).reduce((a, b) => a + b, 0);
  return sum / (windowMs / 1000);
}

/**
 * Relevé nvidia-smi (--query-gpu=clocks.gr,clocks.mem,pstate,power.draw --format=csv,noheader,nounits -lms 200) pendant le
 * trajet (revue finale C1) : médiane et min des fréquences et de la puissance, répartition des P-states. Lignes
 * illisibles ignorées ; aucune ligne ⟹ null (iGPU sans nvidia-smi).
 * @param {string[]} lines
 */
export function smiSummary(lines) {
  const rows = [];
  for (const l of lines) {
    const p = String(l).split(",").map((x) => x.trim());
    if (p.length < 4) continue;
    const gr = Number(p[0]), mem = Number(p[1]), pw = Number(p[3]);
    if (!Number.isFinite(gr) || !Number.isFinite(mem) || !/^P\d+$/.test(p[2])) continue;
    rows.push({ gr, mem, pstate: p[2], pw: Number.isFinite(pw) ? pw : null });
  }
  if (!rows.length) return null;
  const st = (xs) => { const v = xs.filter((x) => x != null); return v.length ? { med: median(v), min: Math.min(...v) } : null; };
  const pstates = {};
  for (const r of rows) pstates[r.pstate] = (pstates[r.pstate] ?? 0) + 1;
  return { samples: rows.length, clocksGrMHz: st(rows.map((r) => r.gr)), clocksMemMHz: st(rows.map((r) => r.mem)), powerW: st(rows.map((r) => r.pw)), pstates };
}
