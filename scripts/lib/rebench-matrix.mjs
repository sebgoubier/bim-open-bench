// LOCAL ONLY (rebench tâche 6) : matrice de la chaîne rebench (scripts/rebench.mjs), sans effet de bord.
// Une case = { key, suite, tool, form, model, rep?, shots } ; key = `${machine}/${suite}/${tool}/${form}/${model}`, suffixée
// de `/r<rep>` pour la suite gpu (répétée GPU_REPEATS fois, boucle externe).
//   suite "open" : node scripts/view.mjs --repeat 3 --warm 2 (ouverture à froid et à chaud, RAM, VRAM) ;
//   suite "gpu"  : node scripts/gpu-path-probe.mjs (temps GPU par image sur le trajet, captures).
// Ordre : maquettes du petit au gros (taille de l'IFC, cumulée pour les assemblages : `bytes` du manifeste) ; pour chaque
// maquette, la suite open puis la suite gpu ; dans chaque suite, viewers ALTERNÉS (Scenoptic, concurrent, Scenoptic, …).
import { readManifest } from "./manifest.mjs";
import { KIT, KIT_MACHINE_RE } from "./kit-profile.mjs"; // local (kit portable) : null sans kit.json

export const MACHINES = ["4090", "igpu"];

// Maquettes publiques (seules autorisées à recevoir --shots) ; toute autre maquette locale est privée : jamais de capture.
export const PUBLIC_MODELS = ["sixty5", "sixty5-building", "sixty5-x2", "sixty5-x4", "sixty5-x8"];
const CONFIDENTIAL = /^private-/; // maquettes locales non publiques : à nommer « private-… »

// Tableau des viewers du plan. suites : où la case existe ; models : liste blanche (absente = toutes) ; outside : libellé
// affiché par le rapport pour une maquette hors liste blanche (case connue, jamais lancée).
// Les variantes Lambert sont des lignes secondaires (géométrie / effets), mesurées en GPU seulement.
// Revue finale C5a : la suite open de Scenoptic passe par les panes -meta (sidecars Arrow, métadonnées IFC par défaut),
// comme That Open dont le .frag porte les propriétés ; la suite gpu garde les panes -rb en géométrie seule.
// props (colonne « propriétés disponibles », 26/10) : "pane" = le pane mesure extra.propsReadyMs (ifc-lite : modèle de
// données parsé en parallèle ; Scenoptic : métadonnées différées ou sidecars) ; "at-done" = propriétés chargées dans le
// même appel que la géométrie (That Open : IfcImporter géométrie puis propriétés, ou .frag qui les porte ; xeokit :
// loadMetadata par défaut, ou .xkt qui les porte) ; absent = géométrie seule.
// Revue finale C5b : xeokit en .xkt d'abord (forme de l'ancre historique), l'IFC brut en ligne secondaire.
// 26/10 (user) : xeokit en IFC brut limité à formModels.ifc (ouverture en minutes, ralentit la chaîne), noté au rapport ;
// suite gpu de xeokit en .xkt seulement (même géométrie, l'ouverture IFC brut en JS prend des minutes).
// 26/10 (cache ifc-lite) : la forme principale d'ifc-lite est « ifc-cache », le cache IndexedDB de son viewer, traité
// comme son format converti (view.mjs l'amorce : une ouverture non comptée le remplit, son temps = la conversion) ;
// l'IFC brut à froid reste sa forme secondaire. gpuForms : formes de la suite gpu quand elles diffèrent de forms (le
// rendu servi par le cache est la même géométrie : la suite gpu d'ifc-lite garde l'IFC brut).
// 26/10 (user) : « l'ouverture du fichier IFC, je veux juste mesurer une fois le temps qu'elle prend ; tous les autres
// bench, c'est avec le format prêt à l'emploi » : l'IFC brut n'est ouvert qu'UNE fois à froid (IFC_OPEN_REPEAT, sans
// rechargement) et la suite gpu ne passe plus par l'IFC, sauf ifc-lite dont c'est la seule voie de rendu (sur
// GPU_IFC_MODELS ; son cache sert 5 à 8 % de triangles en moins).
// 26/10 (user, 2e précision) : « je pensais qu'on laissait le chargement IFC que sur le Sixty5, pas sur les gros modèles » :
// l'IFC brut (ouverture ET trajet ifc-lite) n'existe que sur IFC_MODELS ; ifc-cache (format converti d'ifc-lite) reste partout.
const IFC_MODELS = ["sixty5"];
const LAMBERT_MODELS = ["sixty5"];
const LAMBERT_OUTSIDE = "ligne secondaire (Lambert) mesurée sur Sixty5 seulement";
const IFC_OUTSIDE = "IFC brut mesuré sur Sixty5 seulement (banc rapide, chiffre d'ouverture IFC pris une fois)";
export const VIEWERS = [
  { tool: "scenoptic-rb", forms: ["sceno"], pass: "geometry", suites: ["gpu"], scenoptic: true },
  { tool: "scenoptic-webgpu-rb", forms: ["sgpun"], pass: "geometry", suites: ["gpu"], scenoptic: true },
  { tool: "scenoptic-rb-meta", forms: ["sceno", "ifc"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open"], scenoptic: true, props: "pane" },
  { tool: "scenoptic-webgpu-rb-meta", forms: ["sgpun", "ifc"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open"], scenoptic: true, props: "pane" },
  { tool: "scenoptic-webgpu-rb-lambert", forms: ["sgpun"], formModels: { sgpun: LAMBERT_MODELS }, formOutside: { sgpun: LAMBERT_OUTSIDE }, pass: "geometry", suites: ["gpu"], scenoptic: true, secondary: true },
  { tool: "scenoptic-rb-fx", forms: ["sceno"], pass: "effects", suites: ["gpu"], scenoptic: true },
  { tool: "scenoptic-webgpu-rb-fx", forms: ["sgpun"], pass: "effects", suites: ["gpu"], scenoptic: true },
  { tool: "scenoptic-webgpu-rb-fx-lambert", forms: ["sgpun"], formModels: { sgpun: LAMBERT_MODELS }, formOutside: { sgpun: LAMBERT_OUTSIDE }, pass: "effects", suites: ["gpu"], scenoptic: true, secondary: true },
  { tool: "thatopen", forms: ["frag", "ifc"], gpuForms: ["frag"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open", "gpu"], props: "at-done" },
  { tool: "thatopen-webgpu", forms: ["frag", "ifc"], gpuForms: ["frag"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open", "gpu"], props: "at-done" },
  { tool: "xeokit", forms: ["xkt", "ifc"], gpuForms: ["xkt"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open", "gpu"], props: "at-done" },
  { tool: "ifclite", forms: ["ifc-cache", "ifc"], gpuForms: ["ifc"], formModels: { ifc: IFC_MODELS }, formOutside: { ifc: IFC_OUTSIDE }, pass: "geometry", suites: ["open", "gpu"], models: ["sixty5", "sixty5-building", "sixty5-x2"], outside: "n'ouvre pas (RAM)", props: "pane" },
  { tool: "bim-open-viewer", forms: ["bos"], pass: "geometry", suites: ["open", "gpu"], models: ["sixty5"], outside: "conversion impossible" },
  { tool: "thatopen-fx-composer", forms: ["frag"], pass: "effects", suites: ["gpu"] },
  { tool: "thatopen-fx-deferred", forms: ["frag"], pass: "effects", suites: ["gpu"] },
  { tool: "thatopen-webgpu-fx", forms: ["frag"], pass: "effects", suites: ["gpu"] },
];
// Revue finale C6 : la suite gpu est répétée GPU_REPEATS fois, en boucle externe (r0 de tous les viewers, puis r1…) ;
// les cases gpu en IFC brut n'existent que pour GPU_IFC_MODELS (les autres ne sont jamais affichées).
export const GPU_REPEATS = 3;
// 26/10 (user) : banc plus rapide. Les 3 passes gpu de Sixty5 iGPU ne diffèrent que de < 1 % : une seule passe gpu hors
// GPU_REPEAT_MODELS (Sixty5 garde ses 3 passes, témoin de stabilité). Lambert (ligne secondaire) sur Sixty5 seulement.
export const GPU_REPEAT_MODELS = ["sixty5"];
// local (kit portable) : en mode rapide (kit.json, quick), une seule répétition gpu partout.
export const gpuRepeatsFor = (model, kit = KIT) => (kit?.quick ? 1 : GPU_REPEAT_MODELS.includes(model) ? GPU_REPEATS : 1);
/** Politique de la colonne « propriétés disponibles » d'un viewer : "pane", "at-done" ou null (géométrie seule). */
export const propsPolicy = (tool) => VIEWERS.find((v) => v.tool === tool)?.props ?? null;
export const GPU_IFC_MODELS = ["sixty5"];
/** 26/10 : répétitions de la suite open : l'IFC brut une fois à froid, sans rechargement ; les formats convertis 3 + 2. */
export const IFC_OPEN_REPEAT = { repeat: 1, warm: 0 };
// local (kit v2, 30/10) : le kit peut réduire les répétitions des formats convertis (kit.openRepeat, ex. 2 + 2).
export const openRepeatFor = (form, kit = KIT) => (form === "ifc" ? IFC_OPEN_REPEAT : kit?.openRepeat ? { repeat: kit.openRepeat.repeat, warm: kit.openRepeat.warm } : { repeat: 3, warm: 2 });
// Revue finale C4 : versions de conversion attendues (champ « version » de models/cache/<id>.<forme>.json).
export const EXPECTED_FRAG_VERSION = "3.6.0";
export const DEFAULT_EXPECTED_SHA = "8cc3f30";
export const SCENOPTIC_FORMS = ["sgpun", "sgpu", "sceno", "sgpuq"]; // local (kit portable) : + sgpuq (.sgpu 2.5 ; aucune case du banc principal)
// Délai de chargement commun à view.mjs et gpu-path-probe (revue finale, important 9 : 600 s contre 900 s).
export const LOAD_TIMEOUT_S = 900;
const SUITES = ["open", "gpu"];

/**
 * local (kit portable) : viewers de la matrice selon le profil du kit (VIEWERS tel quel sans kit).
 * quick : sans les lignes secondaires (Lambert), sans l'IFC brut de xeokit (open et gpu) ; les passes à effets restent.
 * forms : remplace les formes d'un viewer dans les deux suites (gpuForms retiré ; formModels garde ses limites par forme).
 * @param {object|null} [kit]
 */
export function viewersFor(kit = KIT) {
  if (!kit) return VIEWERS;
  // kit v2 : exclude retire un viewer ; noOpen lui retire la suite open (il garde la suite gpu).
  return VIEWERS.filter((v) => !(kit.quick && v.secondary) && !(kit.exclude ?? []).includes(v.tool)).map((v) => {
    let out = v;
    if ((kit.noOpen ?? []).includes(v.tool)) out = { ...out, suites: out.suites.filter((s) => s !== "open") };
    if (kit.forms?.[v.tool]) { const { gpuForms, ...rest } = out; out = { ...rest, forms: [...kit.forms[v.tool]] }; }
    if (kit.quick && out.tool === "xeokit") out = { ...out, forms: out.forms.filter((f) => f !== "ifc"), ...(out.gpuForms ? { gpuForms: out.gpuForms.filter((f) => f !== "ifc") } : {}) };
    return out;
  });
}
/** local (kit portable) : machine acceptée (4090 / igpu ; avec un kit, aussi un nom libre). */
export const machineKnown = (machine, kit = KIT) => MACHINES.includes(machine) || (!!kit && KIT_MACHINE_RE.test(String(machine ?? "")));

export const isScenoptic = (tool) => VIEWERS.some((v) => v.tool === tool && v.scenoptic);

/** 26/10 : formes d'un viewer dans une suite (gpuForms pour la suite gpu quand il en a). */
export const formsFor = (v, suite) => (suite === "gpu" && v.gpuForms ? v.gpuForms : v.forms);
/** 26/10 : forme principale d'un viewer dans une suite (la première de formsFor). */
export const mainFormFor = (tool, suite = "open") => { const v = VIEWERS.find((x) => x.tool === tool); return v ? formsFor(v, suite)[0] : undefined; };
/** 26/10 : fichier source d'une forme (« ifc-cache » lit le .ifc). */
export const sourceForm = (form) => String(form).replace(/-cache$/, "");

/** Vrai seulement pour une maquette publique connue : une confidentielle (ou un alias inconnu) n'a jamais de capture. */
export const shotsAllowed = (id) => PUBLIC_MODELS.includes(id) && !CONFIDENTIAL.test(id);

/** Maquettes par défaut : les publiques puis les confidentielles présentes dans le manifeste. */
export function defaultModels(manifest = readManifest()) {
  return manifest.models.map((m) => m.id).filter((id) => PUBLIC_MODELS.includes(id) || CONFIDENTIAL.test(id));
}

/** Taille de l'IFC d'une maquette (`bytes` du manifeste, déjà cumulé pour un assemblage ; sinon somme des parties). */
export function modelBytes(manifest, id) {
  const m = manifest.models.find((x) => x.id === id);
  if (!m) return undefined;
  if (m.bytes != null) return m.bytes;
  return (m.parts ?? []).reduce((t, p) => t + (modelBytes(manifest, p.id ?? p) ?? 0), 0);
}

/** Entrelace deux listes : a0, b0, a1, b1, … puis le reste de la plus longue. */
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return out;
}

/**
 * Matrice des cases, dans l'ordre d'exécution.
 * @param {{ machine: "4090"|"igpu", models: string[], only?: string[], manifest?: object, kit?: object|null }} o
 *   kit (local, kit portable) : profil de kit.json (défaut : celui du banc, null sans kit.json).
 * @returns {Array<{ key: string, suite: "open"|"gpu", tool: string, form: string, model: string, pass: string, rep?: number, shots: boolean }>}
 */
export function buildMatrix({ machine, models, only, manifest = readManifest(), kit = KIT }) {
  const VIEWERS = viewersFor(kit); // local (kit portable) : masque la table globale (identique sans kit)
  if (!machineKnown(machine, kit)) throw new Error(`machine inconnue : ${machine} (attendu : ${MACHINES.join(" | ")})`);
  for (const t of only ?? []) if (!VIEWERS.some((v) => v.tool === t)) throw new Error(`unknown tool ${t} ; connus : ${VIEWERS.map((v) => v.tool).join(", ")}`);
  for (const id of models) if (modelBytes(manifest, id) === undefined) throw new Error(`unknown model ${id}`);
  const viewers = VIEWERS.filter((v) => !only?.length || only.includes(v.tool));
  const sorted = [...new Set(models)].sort((a, b) => modelBytes(manifest, a) - modelBytes(manifest, b) || a.localeCompare(b));
  const matrix = [];
  for (const model of sorted) for (const suite of SUITES) for (let rep = 0; rep < (suite === "gpu" ? gpuRepeatsFor(model, kit) : 1); rep++) {
    // Clé de la suite gpu suffixée de la répétition (…/r0, /r1, /r2) ; captures à la première répétition seulement.
    const key = (v, form) => `${machine}/${suite}/${v.tool}/${form}/${model}${suite === "gpu" ? `/r${rep}` : ""}`;
    const formsOf = (v) => formsFor(v, suite).filter((f) => (suite !== "gpu" || f !== "ifc" || GPU_IFC_MODELS.includes(model)) && (!v.formModels?.[f] || v.formModels[f].includes(model)));
    const cases = (v) => formsOf(v).map((form) => ({ key: key(v, form), suite, tool: v.tool, form, model, pass: v.pass, ...(suite === "gpu" ? { rep } : {}), shots: suite === "gpu" && rep === 0 && shotsAllowed(model) }));
    // kit v2 : modelTools limite une maquette à certains viewers (x16 : Scenoptic seul, les concurrents échouent dès x8).
    const here = viewers.filter((v) => v.suites.includes(suite) && (!v.models || v.models.includes(model)) && (!kit?.modelTools?.[model] || kit.modelTools[model].includes(v.tool)));
    // Première forme de chaque viewer d'abord (tableau principal), les formes secondaires (IFC brut) ensuite.
    const byRank = (list) => { const all = list.map(cases); const out = []; for (let r = 0; r < Math.max(0, ...all.map((c) => c.length)); r++) for (const c of all) if (c[r]) out.push(c[r]); return out; };
    matrix.push(...interleave(byRank(here.filter((v) => v.scenoptic)), byRank(here.filter((v) => !v.scenoptic))));
  }
  return matrix;
}

/**
 * Cases restant à faire : sans les clés déjà faites ; avec `from`, sans tout ce qui précède `from` dans la matrice.
 * @param {ReturnType<typeof buildMatrix>} matrix
 * @param {Set<string>} doneKeys
 * @param {string} [from]
 */
export function pending(matrix, doneKeys, from) {
  let start = 0;
  if (from !== undefined) {
    start = matrix.findIndex((c) => c.key === from);
    if (start < 0) throw new Error(`unknown key ${from}`);
  }
  return matrix.slice(start).filter((c) => !doneKeys.has(c.key));
}

/** Nom du fichier de résultat d'une case GPU (sous <machine>/gpu/). */
export const gpuFileName = (c) => `${c.tool}--${c.form}--${c.model}${c.rep != null ? `--r${c.rep}` : ""}.json`;

/**
 * Commande d'une case. outDir = results/rebench/2026-10-rebench/<machine>.
 * gpu-path-probe écrit dans `${out}.part`, renommé par rebench.mjs selon le code de sortie (reprise sûre).
 * @returns {{ cmd: string, args: string[], out: string }}
 */
export function caseCommand(c, { outDir, timeoutS = LOAD_TIMEOUT_S, expectSha = DEFAULT_EXPECTED_SHA }) {
  if (c.suite === "open") {
    const out = `${outDir}/open.json`;
    // --lost-log : view.mjs écrit « LOST-SIGN … » sur sa sortie à tout signe de perte (lu par rebench.mjs) ;
    // --no-shot : view.mjs capture l'écran de chaque chargement dans results/view/scratch, interdit hors maquettes publiques.
    const args = ["scripts/view.mjs", "--tool", c.tool, "--model", c.model, "--form", c.form, "--repeat", String(openRepeatFor(c.form).repeat), "--warm", String(openRepeatFor(c.form).warm), "--timeout", String(timeoutS), "--lost-log", "--out", out];
    if (!shotsAllowed(c.model)) args.push("--no-shot");
    return { cmd: "node", out, args };
  }
  const out = `${outDir}/gpu/${gpuFileName(c)}`;
  const args = ["scripts/gpu-path-probe.mjs", "--tool", c.tool, "--model", c.model, "--form", c.form, "--out", `${out}.part`, "--timeout", String(timeoutS), "--expect-version", expectSha];
  if (c.rep != null) args.push("--rep", String(c.rep));
  // Double garde : la case ET la maquette doivent l'autoriser.
  if (c.shots && shotsAllowed(c.model)) args.push("--shots", `${outDir}/shots`);
  return { cmd: "node", out, args };
}

/**
 * L'adaptateur relevé (info WebGPU ou chaîne WebGL) est-il celui de la machine demandée ?
 * local (kit portable) : pour une machine libre (hors 4090 / igpu), comparaison à l'adaptateur de référence `ref`
 * (relevé à la première exécution, <série>/<machine>/adapter.json) : même fabricant et même description.
 */
export function adapterMatches(machine, adapter, ref) {
  if (!adapter) return false;
  if (!MACHINES.includes(machine)) return ref ? sameAdapter(ref, adapter) : false; // local (kit portable)
  const text = typeof adapter === "string" ? adapter : [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(" ");
  if (machine === "4090") return /nvidia/i.test(text) && !/intel/i.test(text);
  if (machine === "igpu") return /intel/i.test(text) && !/nvidia/i.test(text);
  return false;
}

// local (kit portable) : signature d'un adaptateur pour une machine libre.
const VENDORS = [["nvidia", /nvidia|geforce|quadro/i], ["amd", /\bamd\b|radeon|\bati\b|advanced micro/i], ["intel", /intel/i], ["apple", /apple/i], ["qualcomm", /qualcomm|adreno/i], ["arm", /\barm\b|mali/i]];
const normName = (s) => String(s ?? "").toLowerCase().replace(/\((r|tm)\)/g, "").replace(/\s+/g, " ").trim();
/** Nom du GPU dans une chaîne de renderer WebGL ANGLE (« ANGLE (Intel, Intel(R) UHD Graphics (0x…) Direct3D11 … ») ; sinon la chaîne. */
const glName = (s) => { const m = String(s ?? "").match(/ANGLE \([^,]+,\s*(.+?)\s*(?:\(0x[0-9a-f]+\)|Direct3D|OpenGL|Vulkan|Metal|,|\)$)/i); return m ? m[1] : String(s ?? ""); };
/** Fabricant (nvidia, amd, intel, apple, qualcomm, arm) d'un texte libre, ou null. */
export const adapterVendor = (text) => VENDORS.find(([, re]) => re.test(String(text ?? "")))?.[0] ?? null;
/**
 * Signature { vendor, description } d'un adaptateur : objet WebGPU ({ vendor, description… }), chaîne WebGL, objet JSON
 * sérialisé, ou relevé complet de la sonde ({ webgpu, webgl }) / adapter.json.
 */
export function adapterSignature(adapter) {
  let a = adapter;
  if (typeof a === "string" && a.trim().startsWith("{")) { try { a = JSON.parse(a); } catch {} }
  if (a == null) return { vendor: null, description: "" };
  if (typeof a === "string") return { vendor: adapterVendor(a), description: normName(glName(a)) };
  if ("webgpu" in a || "webgl" in a) {
    const g = a.webgpu && !a.webgpu.error ? adapterSignature(a.webgpu) : { vendor: null, description: "" }, gl = adapterSignature(a.webgl ?? null);
    return { vendor: g.vendor ?? gl.vendor, description: g.description || gl.description };
  }
  if ("vendor" in a || "description" in a) return { vendor: adapterVendor(a.vendor) ?? adapterVendor(a.description) ?? adapterVendor(a.architecture), description: normName(a.description) };
  return { vendor: null, description: "" };
}
/** Même adaptateur que la référence : même fabricant ; descriptions égales (ou l'une contient l'autre) quand les deux sont connues. */
export function sameAdapter(ref, adapter) {
  const r = adapterSignature(ref), s = adapterSignature(adapter);
  if (!r.vendor || !s.vendor || r.vendor !== s.vendor) return false;
  if (r.description && s.description && !(r.description.includes(s.description) || s.description.includes(r.description))) return false;
  return true;
}

/** Un texte (message, erreur console) signale-t-il une perte de périphérique ou de contexte ? */
export const looksLost = (text) => /device[ _-]?lost|context[ _-]?lost|DEVICE_HUNG|DEVICE_REMOVED|DXGI_ERROR_DEVICE|target crashed|GPU process|LOST-SIGN/i.test(String(text ?? ""));

/**
 * Un enregistrement de view.mjs compte-t-il pour la machine ? Renderer WebGL de la bonne machine (view.mjs appelle
 * requestAdapter() sans préférence : WebGL = adaptateur du processus GPU), aucun signe de perte, pas de timeout.
 * Un enregistrement refusé n'est pas « fait » : la relance de view.mjs le remplace (mêmes clés tool/model/form/pass/rep).
 */
export function openRecordValid(machine, r, ref) {
  if (!adapterMatches(machine, r?.gpu?.webgl?.renderer, ref)) return false; // local (kit portable) : ref d'une machine libre
  if (looksLost(r.message) || (r.consoleErrors ?? []).some(looksLost)) return false;
  return r.outcome !== "timeout";
}

/** Case open faite : ses répétitions à froid (pass 0 ; 3, ou 1 pour l'IFC brut) présentes et valides pour la machine. */
export function openCaseDone(machine, c, runs, ref) {
  const recs = (runs ?? []).filter((r) => r.tool === c.tool && r.model === c.model && r.form === c.form && r.renderer === "hardware");
  return Array.from({ length: openRepeatFor(c.form).repeat }, (_, i) => i).every((rep) => {
    const mine = recs.filter((r) => (r.rep ?? 0) === rep);
    return mine.some((r) => (r.pass ?? 0) === 0) && mine.every((r) => openRecordValid(machine, r, ref));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Revue finale C4 : contrôle des conversions (présence ET version).

/** La version relevée correspond-elle au sha attendu (court ou long, dans un sens ou dans l'autre) ? */
const shaMatches = (v, sha) => { const a = String(v ?? "").toLowerCase(), b = String(sha ?? "").toLowerCase(); return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)); };

/** Version attendue pour une forme (null = forme sans contrôle de version : ifc, bos, xkt…). */
export function expectedVersion(form, expectSha = DEFAULT_EXPECTED_SHA, kit = KIT) {
  if (kit?.expect?.[form] != null) return String(kit.expect[form]); // local (kit portable) : version attendue par forme
  if (form === "frag") return EXPECTED_FRAG_VERSION;
  if (SCENOPTIC_FORMS.includes(form)) return expectSha;
  return null;
}

/**
 * Conversion d'une case utilisable ? Présence (enregistrement models/cache/<id>.<forme>.json ET fichier converti ; pour
 * l'IFC, le fichier seul) puis, pour frag et sgpun/sgpu/sceno, version de l'enregistrement : frag = 3.6.0, Scenoptic =
 * le sha attendu (--expect-version, défaut 8cc3f30). Un assemblage exige chacune de ses parties.
 * Sans effet de bord : `io.exists(nom)` et `io.readRecord(nom)` (JSON ou null) lisent models/cache.
 * @returns {{ ok: boolean, reason: string|null, versions: Record<string, string|null> }}
 */
export function conversionCheck(id, form, { manifest, io, expectSha = DEFAULT_EXPECTED_SHA, kit = KIT }) {
  const m = manifest.models.find((x) => x.id === id);
  if (m?.parts?.length) {
    const versions = {};
    for (const p of m.parts) {
      const r = conversionCheck(p.id ?? p, form, { manifest, io, expectSha, kit });
      Object.assign(versions, r.versions);
      if (!r.ok) return { ok: false, reason: `partie ${p.id ?? p} : ${r.reason}`, versions };
    }
    return { ok: true, reason: null, versions };
  }
  // 26/10 : ifc-cache lit le .ifc (aucune conversion à contrôler : le cache se construit dans le navigateur).
  if (sourceForm(form) === "ifc") return io.exists(`${id}.ifc`) ? { ok: true, reason: null, versions: { [id]: null } } : { ok: false, reason: "conversion absente (IFC absent du cache)", versions: { [id]: null } };
  if (!io.exists(`${id}.${form}.json`) || !io.exists(`${id}.${form}`)) return { ok: false, reason: "conversion absente", versions: { [id]: null } };
  const rec = io.readRecord(`${id}.${form}.json`);
  const v = rec?.version ?? null;
  const versions = { [id]: v };
  const want = expectedVersion(form, expectSha, kit);
  if (want == null) return { ok: true, reason: null, versions };
  const good = form === "frag" ? v === want : shaMatches(v, want);
  return good ? { ok: true, reason: null, versions } : { ok: false, reason: `conversion périmée : version ${v ?? "absente"}, attendu ${want}${rec?.build ? ` (${rec.build})` : ""}`, versions };
}

// ---------------------------------------------------------------------------------------------------------------
// Revue finale C3 : décision d'une case après sa sous-commande, en fonction PURE (testée).

/**
 * Statut d'une case terminée. Ordre des tests (C3) : garde-fou RAM d'abord (un Chrome tué par garde-ram.ps1 se voit
 * aussi comme « target crashed » / code 3), puis perte, conversion refusée par la sonde, adaptateur, autre Chrome du
 * banc (contended, gpu), résultat.
 * @param {{ suite: "open"|"gpu", machine: string, code: number, ramKill: boolean, lostLines?: string[],
 *   res?: object|null, recs?: object[], openComplete?: boolean }} o
 *   res = sortie de gpu-path-probe (.part) ; recs = enregistrements open de CETTE exécution ; openComplete = openCaseDone ;
 *   refAdapter (local, kit portable) = adaptateur de référence d'une machine libre (adapter.json).
 * @returns {{ status: "OK"|"FAIL"|"RAM"|"LOST"|"ADAPT"|"CONTENDED"|"SKIP"|"ERR", stop: 3|4|null, suffix: string|null, detail: string, done: boolean }}
 *   stop = code de sortie de la chaîne (null : on continue) ; suffix (gpu) = suffixe du .part renommé (« » = résultat
 *   définitif) ; done = la case compte comme faite à la reprise (résultat définitif, ou RAM noté au journal).
 */
export function classifyCase({ suite, machine, code, ramKill, lostLines = [], res = null, recs = [], openComplete = false, refAdapter }) {
  const adapterText = (x) => (x == null ? null : typeof x === "string" ? x : JSON.stringify(x));
  if (ramKill) return { status: "RAM", stop: null, suffix: ".ram", detail: `n'ouvre pas (RAM) : garde-fou déclenché, code ${code}`, done: true };
  if (suite === "gpu") {
    if (code === 3 || res?.lost || lostLines.length) return { status: "LOST", stop: 3, suffix: ".lost", detail: `code ${code} ${res?.lost ?? lostLines[0] ?? ""}`.trim().slice(0, 300), done: false };
    if (!res) return { status: "ERR", stop: null, suffix: ".err", detail: `code ${code}, aucune sortie de sonde`, done: false };
    if (res.conversionCheck && !res.conversionCheck.ok) return { status: "SKIP", stop: null, suffix: ".skip", detail: `skipped: ${res.conversionCheck.reason}`, done: false };
    if (code !== 0 && code !== 2) return { status: "ERR", stop: null, suffix: ".err", detail: `code ${code} ${res.error ?? ""}`.trim().slice(0, 300), done: false };
    if (code === 0 && !res.adapter) return { status: "ERR", stop: null, suffix: ".err", detail: "adaptateur inconnu (res.adapter nul) : case refaite à la relance", done: false };
    if (res.adapter && !adapterMatches(machine, adapterText(res.adapter), refAdapter)) return { status: "ADAPT", stop: 4, suffix: ".wrongadapter", detail: `adaptateur du viewer : ${adapterText(res.adapter)}`, done: false };
    if (res.benchContext?.contended) return { status: "CONTENDED", stop: null, suffix: ".contended", detail: `autre Chrome du banc pendant la mesure : ${JSON.stringify(res.benchContext.othersAtStart?.length ? res.benchContext.othersAtStart : res.benchContext.othersAtEnd ?? [])} : case refaite à la relance`.slice(0, 300), done: false };
    const f = res.flags ?? {};
    if (code === 2) return { status: "FAIL", stop: null, suffix: "", detail: `${/délai dépassé/.test(`${f.reason ?? ""} ${res.status ?? ""}`) ? "délai dépassé" : "chargement non terminé"} : ${res.status ?? ""}`.slice(0, 300), done: true };
    const detail = `gpu méd ${res.path?.gpuMsMed ?? "non mesuré"} ms p95 ${res.path?.gpuMsP95 ?? "-"}${f.gpuUnmeasured ? ` gpuUnmeasured(${f.reason})` : ""}${f.boostSuspect ? " boostSuspect" : ""}${f.tsQuantized ? " tsQuantized" : ""}${res.cadence?.overruns ? ` dépassements ${res.cadence.overruns}/${res.cadence.steps}` : ""}${res.cpu?.totalMsPerSec != null ? ` cpu ${res.cpu.totalMsPerSec} ms/s` : ""}${res.smi?.relevant && res.smi.clocksGrMHz?.med != null ? ` horloge ${res.smi.clocksGrMHz.med} MHz` : ""} version ${res.version ?? "?"} conversion ${JSON.stringify(res.conversion?.versions ?? null)} adaptateur ${adapterText(res.adapter)}`;
    return { status: "OK", stop: null, suffix: "", detail, done: true };
  }
  // suite open (view.mjs ne sort jamais en code 3 : c'est la chaîne qui arrête)
  const lostRec = recs.find((r) => looksLost(r.message) || (r.consoleErrors ?? []).some(looksLost));
  if (lostLines.length || lostRec) return { status: "LOST", stop: 3, suffix: null, detail: (lostLines[0] ?? `${lostRec.message ?? ""} ${(lostRec.consoleErrors ?? []).find(looksLost) ?? ""}`).slice(0, 300), done: false };
  // view.mjs appelle requestAdapter() sans préférence : on juge sur le renderer WebGL (adaptateur du processus GPU).
  const bad = recs.find((r) => r.gpu?.webgl?.renderer && !adapterMatches(machine, r.gpu.webgl.renderer, refAdapter));
  if (bad) return { status: "ADAPT", stop: 4, suffix: null, detail: `adaptateur de view.mjs : ${bad.gpu.webgl.renderer}`, done: false };
  if (openComplete) {
    const fails = recs.filter((r) => r.outcome !== "done");
    if (fails.length) return { status: "FAIL", stop: null, suffix: null, detail: `${fails.length} chargement(s) non terminé(s) : ${fails[0].message ?? fails[0].outcome}`.slice(0, 300), done: true };
    const cold = recs.filter((r) => (r.pass ?? 0) === 0);
    const v = cold.map((r) => r.doneMs).filter((x) => x != null).sort((a, b) => a - b);
    return { status: "OK", stop: null, suffix: null, detail: `froid done méd ${v.length ? v[Math.floor((v.length - 1) / 2)] : null} ms, RAM max ${Math.max(0, ...recs.map((r) => r.memory?.load?.ramMB ?? 0))} Mo, version ${recs[0]?.version ?? "?"}, conversion ${JSON.stringify(recs[0]?.conversion ?? null)}`, done: true };
  }
  const timeouts = recs.filter((r) => r.outcome === "timeout").length;
  return { status: "ERR", stop: null, suffix: null, detail: `code ${code}, ${recs.length} enregistrement(s) sur ${openRepeatFor(recs[0]?.form).repeat * (1 + openRepeatFor(recs[0]?.form).warm)}${timeouts ? `, ${timeouts} délai(s) dépassé(s) : case refaite à la relance` : ""}`, done: false };
}

/** Important 3 : deux cases « contended » de suite ⟹ arrêt de la chaîne (un SKIP entre les deux ne remet pas à zéro). */
export function contendedStreak(prev, status) {
  const streak = status === "CONTENDED" ? prev + 1 : status === "SKIP" ? prev : 0;
  return { streak, stop: streak >= 2 };
}
