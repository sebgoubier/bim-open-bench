#!/usr/bin/env node
// LOCAL ONLY (rebench tâche 6) : chaîne de mesure du rebench concurrents, une case à la fois.
//   node scripts/rebench.mjs --machine 4090|igpu [--models a,b] [--only <tool>[,<tool>]] [--from <key>] [--max <n>] [--expect-version <sha>] [--dry]
// (scripts/rebench.ps1 lance d'abord le garde-fou RAM D:/tmp/conv/garde-ram.ps1, puis ce script.)
//
// Matrice : lib/rebench-matrix.mjs (viewers alternés, maquettes du petit au gros). Chaque case lance UNE sous-commande :
//   open : node scripts/view.mjs --tool T --model M --form F --repeat 3 --warm 2 (IFC brut : --repeat 1 --warm 0) --out <machine>/open.json
//          (view.mjs fusionne : une relance remplace les enregistrements de même tool/model/form/renderer/pass/rep) ;
//   gpu  : node scripts/gpu-path-probe.mjs … --out <machine>/gpu/<tool>--<form>--<model>.json.part [--shots <machine>/shots]
//          (--shots pour les maquettes publiques SEULEMENT ; le .part est renommé selon le code de sortie).
// Le verrou du banc (results/view/.view.lock) n'est PAS tenu par la chaîne : chaque sous-commande le prend elle-même
// (une autre session peut mesurer entre deux cases). La chaîne ne le tient que pendant la courte sonde d'adaptateur.
//
// Sorties : results/rebench/2026-10-rebench/<machine>/{open.json, gpu/<…>.json, journal.log, logs/<…>.log, shots/}.
// Journal : une ligne par case, « <date ISO> <STATUT> <clé> <durée> <détail> » ; lignes « # » = relevé machine.
//   OK    case mesurée ;                        FAIL  case mesurée, chargement non terminé / échoué (résultat gardé) ;
//   SKIP  conversion absente OU périmée (revue finale C4 : version de models/cache/<id>.<forme>.json ≠ 3.6.0 pour frag,
//         ≠ --expect-version, défaut 8cc3f30, pour sgpun/sgpu/sceno ; raison au journal ; refaite à la prochaine exécution) ;
//   RAM   sous-commande arrêtée par le garde-fou RAM (« n'ouvre pas (RAM) », comptée comme faite) ; testé AVANT la perte
//         (revue finale C3 : un Chrome tué par le garde-fou se voit aussi comme « target crashed » / code 3), 2 s après
//         la fin de la sous-commande pour laisser le garde-fou écrire son journal ;
//   CONTENDED autre Chrome du banc pendant la mesure (gpu) : case NON faite (refaite à la relance) ; deux de suite ⟹ STOP, code 5 ;
//   ERR   erreur de la sous-commande (refaite à la prochaine exécution) ;
//   LOST  périphérique / contexte perdu ⟹ STOP de toute la chaîne, code 3 ;
//   ADAPT adaptateur de la case ≠ machine demandée ⟹ STOP, code 4 ;
//   TIMEOUT (kit v2) plafond de durée de la case (kit.caseTimeoutS) atteint : sous-commande tuée, case comptée faite.
// Reprise : une case est faite si son gpu/<…>.json existe (open : ses 3 répétitions sont dans open.json), ou si le
// journal la note RAM. --from <clé> saute en plus tout ce qui précède la clé ; rien n'est dupliqué ni écrasé.
// Décision d'une case : classifyCase (lib/rebench-matrix.mjs, testée).
// Codes de sortie : 0 ; 2 usage ; 3 device perdu ; 4 mauvais adaptateur ; 5 deux cases contended de suite.
//
// local (kit portable) : avec <racine>/kit.json (lib/kit-profile.mjs, écrit par scripts/kit.mjs), machine libre ou
// --machine auto (nom dérivé de l'adaptateur et du nom d'hôte), adaptateur de référence mémorisé dans
// <série>/<machine>/adapter.json à la première exécution (contrôle ADAPT, code 4), série KIT.series, mode rapide.
// Sans kit.json, rien ne change. BENCH_GUARD_LOG : journal du garde-fou RAM (défaut D:/tmp/conv/garde-ram.log).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, createWriteStream, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { benchProfile } from "./lib/bench-profile.mjs";
import { acquireBenchLock } from "./lib/bench-lock.mjs";
import { KIT } from "./lib/kit-profile.mjs";
import { readManifest } from "./lib/manifest.mjs";
import { cacheDir, root } from "./lib/paths.mjs";
import { adapterMatches, adapterSignature, buildMatrix, caseCommand, classifyCase, contendedStreak, conversionCheck, DEFAULT_EXPECTED_SHA, defaultModels, gpuFileName, looksLost, MACHINES, openCaseDone, pending, sameAdapter } from "./lib/rebench-matrix.mjs";
import { startServer } from "./serve.mjs";

const SERIES = KIT?.series ?? "results/rebench/2026-10-rebench"; // local (kit portable) : série du kit
const GUARD_LOG = process.env.BENCH_GUARD_LOG ?? "D:/tmp/conv/garde-ram.log"; // local (kit portable) : garde-fou du kit
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- arguments (une liste peut arriver en plusieurs mots : PowerShell découpe « a,b » non guillemeté) ---
function parseArgs(argv) {
  const a = { models: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const list = () => { const v = []; while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) v.push(...argv[++i].split(",")); return v.map((s) => s.trim()).filter(Boolean); };
    if (k === "--dry") a.dry = true;
    else if (k === "--machine") a.machine = argv[++i];
    else if (k === "--from") a.from = argv[++i];
    else if (k === "--expect-version") a.expectSha = argv[++i]; // revue finale C4 : sha attendu des conversions Scenoptic
    else if (k === "--max") a.max = Number(argv[++i]); // rodage : au plus N cases LANCÉES (les SKIP ne comptent pas)
    else if (k === "--models") a.models.push(...list());
    else if (k === "--only") a.only.push(...list());
    else { console.error(`argument inattendu : ${k}`); usage(); }
  }
  if (!a.machine && KIT?.machine) a.machine = KIT.machine; // local (kit portable) : machine du kit (souvent « auto »)
  if (!a.machine) usage();
  return a;
}
function usage() { console.error("usage : node scripts/rebench.mjs --machine 4090|igpu [--models a,b] [--only <tool>] [--from <key>] [--max <n>] [--expect-version <sha>] [--dry]"); process.exit(2); }

const args = parseArgs(process.argv.slice(2));
// local (kit portable) : --machine auto (ou « auto » de kit.json) = kit-<nom d'hôte>-<fabricant de l'adaptateur>.
// La sonde d'adaptateur part alors avant la matrice (son relevé resert plus bas) ; --dry ne lance pas Chrome : il
// reprend le dossier kit-<hôte>-* d'une exécution précédente (adapter.json), sinon kit-<hôte>-gpu.
// Nom de machine SANS nom d'hôte (il finirait dans le rapport) : identifiant neutre posé par le lanceur du kit
// (BENCH_MACHINE_ID, tiré au hasard une fois par copie du kit), plus le type de GPU demandé (BENCH_EXPECT_GPU).
const hostTag = () => (String(process.env.BENCH_MACHINE_ID ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "poste");
const expectGpu = ["igpu", "dgpu"].includes(process.env.BENCH_EXPECT_GPU) ? process.env.BENCH_EXPECT_GPU : null;
const autoMachineName = (adapter) => `kit-${hostTag()}-${expectGpu ? `${expectGpu}-` : ""}${adapterSignature(adapter).vendor ?? "gpu"}`;
/** GPU demandé (BENCH_EXPECT_GPU) contre fabricant relevé : intégré = Intel (ou AMD), dédié = NVIDIA (ou AMD). */
const gpuKindOk = (adapter) => { const v = adapterSignature(adapter).vendor; if (!expectGpu || !v) return true; return expectGpu === "igpu" ? v !== "nvidia" : v !== "intel"; };
let earlyAdapter = null;
if (args.machine === "auto") {
  if (!KIT) { console.error("--machine auto : réservé au kit portable (kit.json à la racine du banc)"); process.exit(2); }
  if (args.dry) {
    const prefix = `kit-${hostTag()}-`;
    const seen = (() => { try { return readdirSync(join(root, SERIES)).filter((d) => d.startsWith(prefix) && existsSync(join(root, SERIES, d, "adapter.json"))); } catch { return []; } })();
    args.machine = seen[0] ?? `${prefix}gpu`;
    console.log(`(--machine auto, --dry : ${seen[0] ? "dossier d'une exécution précédente" : "nom provisoire, le fabricant sera relevé au lancement"} : ${args.machine})`);
  } else {
    earlyAdapter = await probeAdapter();
    if (!gpuKindOk(earlyAdapter)) {
      console.error(`GPU demandé ${expectGpu} mais Chrome tourne sur ${adapterSignature(earlyAdapter).vendor} (${adapterSignature(earlyAdapter).description}) : réglage Windows de préférence GPU non appliqué. Arrêt (code 4).`);
      process.exit(4);
    }
    args.machine = autoMachineName(earlyAdapter);
    console.log(`--machine auto : ${args.machine}`);
  }
}
const freeMachine = !MACHINES.includes(args.machine); // local (kit portable) : machine libre, contrôle par adapter.json
const expectSha = args.expectSha ?? DEFAULT_EXPECTED_SHA;
const manifest = readManifest();
let matrix;
try { matrix = buildMatrix({ machine: args.machine, models: args.models.length ? args.models : KIT?.models?.length ? KIT.models : defaultModels(manifest), only: args.only, manifest }); }
catch (e) { console.error(e.message); process.exit(2); }

// Chaque case doit exister dans site/panes.json (tool et forme), sinon la sous-commande échouerait plus loin.
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
const panes = JSON.parse(readFileSync(join(root, "site", "panes.json"), "utf8")).panes;
for (const c of matrix) { const p = panes.find((x) => x.tool === c.tool); if (!p || !p.forms.includes(c.form)) { console.error(`pane ${c.tool} sans forme ${c.form} dans site/panes.json`); process.exit(2); } }

const outDir = `${SERIES}/${args.machine}`;
const abs = (p) => join(root, p);
const journalPath = abs(`${outDir}/journal.log`);
// local (kit portable) : adaptateur de référence d'une machine libre (relevé à la première exécution).
const adapterRefPath = abs(`${outDir}/adapter.json`);
let refAdapter = freeMachine ? readJson(adapterRefPath) ?? undefined : undefined;

// --- conversion présente ET à la bonne version ? (revue finale C4 ; assemblage = toutes ses parties) ---
const cacheIo = { exists: (n) => existsSync(join(cacheDir, n)), readRecord: (n) => readJson(join(cacheDir, n)) };
const conversion = (id, form) => conversionCheck(id, form, { manifest, io: cacheIo, expectSha });

// --- cases déjà faites ---
function openRecords(c) {
  const runs = readJson(abs(`${outDir}/open.json`))?.runs ?? [];
  return runs.filter((r) => r.tool === c.tool && r.model === c.model && r.form === c.form && r.renderer === "hardware");
}
// Faite = 3 répétitions VALIDES pour cette machine (renderer WebGL de la machine, sans perte, sans timeout) : des
// mesures d'une case arrêtée en ADAPT / LOST restent dans open.json mais ne comptent pas, la relance les remplace.
const openComplete = (c) => openCaseDone(args.machine, c, readJson(abs(`${outDir}/open.json`))?.runs, refAdapter);
function journalKeys(status) {
  if (!existsSync(journalPath)) return new Set();
  const keys = new Set();
  for (const l of readFileSync(journalPath, "utf8").split(/\r?\n/)) { const m = l.match(/^\S+ (\S+)\s+(\S+)/); if (m && m[1] === status) keys.add(m[2]); }
  return keys;
}
// kit v2 (30/10) : l'ouverture dépend du processeur, pas du GPU (mêmes chiffres sur l'iGPU et la carte dédiée d'un même
// PC) : avec openOncePerHost, une case open déjà faite par une autre machine de la MÊME copie du kit (kit-<id>-…) compte
// comme faite ici. Ses mesures restent dans le dossier de cette autre machine.
const hostSiblings = () => {
  if (!KIT?.openOncePerHost || !args.machine.startsWith("kit-")) return [];
  const prefix = `kit-${hostTag()}-`;
  try {
    return readdirSync(abs(SERIES)).filter((d) => d !== args.machine && d.startsWith(prefix) && existsSync(abs(`${SERIES}/${d}/adapter.json`)))
      .map((d) => ({ machine: d, runs: readJson(abs(`${SERIES}/${d}/open.json`))?.runs ?? [], ref: readJson(abs(`${SERIES}/${d}/adapter.json`)) ?? undefined }));
  } catch { return []; }
};
const openDoneElsewhere = (c, sibs) => sibs.find((s) => openCaseDone(s.machine, c, s.runs, s.ref))?.machine ?? null;
function doneKeys() {
  // TIMEOUT (kit v2) : case arrêtée au plafond de durée, comptée faite comme RAM (la limite du viewer est le résultat).
  const done = new Set([...journalKeys("RAM"), ...journalKeys("TIMEOUT")]);
  const sibs = hostSiblings();
  for (const c of matrix) {
    if (c.suite === "gpu" && existsSync(abs(`${outDir}/gpu/${gpuFileName(c)}`))) done.add(c.key);
    if (c.suite === "open" && (openComplete(c) || (sibs.length && openDoneElsewhere(c, sibs)))) done.add(c.key);
  }
  return done;
}

let todo;
try { todo = pending(matrix, doneKeys(), args.from); } catch (e) { console.error(e.message); process.exit(2); }

// --- --dry : la liste, rien n'est lancé ---
if (args.dry) {
  const done = doneKeys(), todoKeys = new Set(todo.map((c) => c.key));
  console.log(`rebench ${args.machine} : ${matrix.length} cases, ${todo.length} à faire (--dry : rien n'est lancé, pas de relevé machine)`);
  for (const [i, c] of matrix.entries()) {
    const conv = conversion(c.model, c.form);
    const state = done.has(c.key) ? "fait" : !todoKeys.has(c.key) ? "avant --from" : !conv.ok ? "SKIP" : "à faire";
    const cmd = caseCommand(c, { outDir, expectSha });
    console.log(`${String(i + 1).padStart(3)} ${state.padEnd(18)} ${c.key}${state === "SKIP" ? ` (${conv.reason})` : ""}${state === "à faire" ? `\n      ${cmd.cmd} ${cmd.args.join(" ")}` : ""}`);
  }
  process.exit(0);
}

// --- journal ---
mkdirSync(abs(`${outDir}/gpu`), { recursive: true });
mkdirSync(abs(`${outDir}/logs`), { recursive: true });
const journal = (line) => { appendFileSync(journalPath, line + "\n"); console.log(`[journal] ${line}`); };
const caseLine = (status, c, ms, detail = "") => journal(`${new Date().toISOString()} ${status.padEnd(5)} ${c.key} ${Math.round(ms / 1000)}s ${detail}`.trimEnd());

// --- relevé machine ---
function run(cmd, a) { try { const r = spawnSync(cmd, a, { encoding: "utf8", timeout: 15000 }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } }
function readPowerScheme() {
  const s = run("powercfg", ["-getactivescheme"]);
  const m = s?.match(/([0-9a-f]{8}-[0-9a-f-]{27})\s*\(([^)]*)\)/i); // powercfg écrit en page de code OEM : GUID + nom
  return m ? `${m[1]} (${m[2]})` : s?.replace(/\s+/g, " ") ?? null;
}
function readNvidiaPower() {
  const s = run("nvidia-smi", ["-q", "-d", "POWER"]);
  if (!s) return null;
  // On garde les lignes « clé : valeur » utiles (nom, état, consommation, limites), sur une ligne.
  return s.split(/\r?\n/).map((l) => l.trim()).filter((l) => /:/.test(l) && !/^(=|Timestamp|Driver Version|CUDA Version|Attached GPUs)/.test(l)).map((l) => l.replace(/\s+:\s+/, "=")).filter((l) => !/=(N\/A|Not Found)$/.test(l)).join(" | ");
}

/** Sonde d'adaptateur : un Chrome headless neuf (mêmes drapeaux GPU que les sondes), requestAdapter high-performance. */
async function probeAdapter() {
  const release = await acquireBenchLock(`rebench sonde adaptateur ${args.machine}`);
  const server = await startServer(0);
  const profile = benchProfile("rebench-adapter-");
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "about:blank"], { stdio: "ignore" });
  try {
    let ws;
    for (let i = 0; i < 100 && !ws; i++) {
      try { const p = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\s+/)[0]; const t = await (await fetch(`http://127.0.0.1:${p}/json/new?about:blank`, { method: "PUT" })).json(); ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); }
      catch { ws = undefined; await sleep(200); }
    }
    if (!ws) throw new Error("Chrome injoignable (DevTools)");
    let id = 1; const pend = new Map();
    ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise((ok) => { const i = id++; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable");
    // Contexte sûr (127.0.0.1) pour navigator.gpu : un document affiché du serveur du banc (un .md partirait en
    // téléchargement et laisserait about:blank, sans navigator.gpu : constaté au premier essai).
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/site/panes.json` });
    await sleep(1500);
    const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const out = { webgpu: null, webgl: null };
      try { const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" }); const i = a?.info;
        out.webgpu = a ? { vendor: i?.vendor, architecture: i?.architecture, device: i?.device, description: i?.description } : null; } catch (e) { out.webgpu = { error: String(e) }; }
      try { const gl = document.createElement("canvas").getContext("webgl2"); const d = gl?.getExtension("WEBGL_debug_renderer_info");
        out.webgl = gl ? (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null; } catch (e) { out.webgl = String(e); }
      return out; })()` });
    try { ws.close(); } catch {}
    return r.result?.result?.value ?? { webgpu: null, webgl: null };
  } finally {
    // Seulement NOTRE Chrome (arbre du pid lancé), jamais par motif.
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    release();
  }
}

const adapter = earlyAdapter ?? await probeAdapter(); // local (kit portable) : relevé déjà fait pour --machine auto
const scheme = readPowerScheme(), nv = readNvidiaPower();
journal(`# ${new Date().toISOString()} DÉBUT rebench --machine ${args.machine} : ${matrix.length} cases, ${todo.length} à faire${args.from ? `, --from ${args.from}` : ""}`);
journal(`# adaptateur WebGPU (high-performance) : ${JSON.stringify(adapter.webgpu)} ; WebGL : ${adapter.webgl}`);
journal(`# powercfg : ${scheme ?? "illisible"}`);
{ const sibs = hostSiblings(); const n = sibs.length ? matrix.filter((c) => c.suite === "open" && !openComplete(c) && openDoneElsewhere(c, sibs)).length : 0;
  if (n) journal(`# ouverture déjà mesurée sur ${sibs.map((s) => s.machine).join(", ")} (même PC, openOncePerHost) : ${n} case(s) open sautée(s)`); }
journal(`# nvidia-smi -q -d POWER : ${nv ?? "indisponible"}`);
// local (kit portable) : machine libre : la première exécution mémorise l'adaptateur (adapter.json) ; les suivantes,
// et chaque case, doivent retrouver le même (même fabricant et même description), sinon STOP code 4 comme ailleurs.
if (freeMachine) {
  const seen = { vendor: adapterSignature(adapter).vendor, description: adapterSignature(adapter).description, webgpu: adapter.webgpu ?? null, webgl: adapter.webgl ?? null, hostname: hostname(), at: new Date().toISOString() };
  if (!seen.vendor) stop(4, `# STOP adaptateur : fabricant illisible, relevé ${JSON.stringify(adapter)}`);
  if (!refAdapter) { writeFileSync(adapterRefPath, JSON.stringify(seen, null, 2) + "\n"); refAdapter = seen; journal(`# adaptateur de référence mémorisé (${outDir}/adapter.json) : ${seen.vendor} ${seen.description}`); }
  else if (!sameAdapter(refAdapter, adapter)) {
    journal(`# STOP adaptateur : attendu ${refAdapter.vendor} ${refAdapter.description} (adapter.json), relevé ${JSON.stringify(adapter.webgpu) ?? adapter.webgl}`);
    console.error(`\nSTOP : Chrome n'est pas sur l'adaptateur de la première exécution (${refAdapter.vendor} ${refAdapter.description}). ` +
      "Remettre Chrome sur ce GPU (Paramètres Windows > Système > Écran > Graphiques), fermer tous les Chrome, puis relancer.");
    process.exit(4);
  }
} else if (!adapterMatches(args.machine, adapter.webgpu?.vendor || adapter.webgpu?.description ? adapter.webgpu : adapter.webgl)) {
  const want = args.machine === "4090" ? "NVIDIA (RTX 4090)" : "Intel (iGPU)";
  journal(`# STOP adaptateur : attendu ${want}, relevé ${JSON.stringify(adapter.webgpu) ?? adapter.webgl}`);
  console.error(`\nSTOP : Chrome n'est pas sur ${want}. Basculer Chrome dans Paramètres Windows > Système > Écran > Graphiques ` +
    `(Google Chrome : ${args.machine === "4090" ? "« Hautes performances »" : "« Économie d'énergie »"}), fermer tous les Chrome, puis relancer.`);
  process.exit(4);
}

// --- exécution d'une case ---
const guardSize = () => { try { return statSync(GUARD_LOG).size; } catch { return 0; } };
// kit v2 : timeoutMs = plafond de la case ; au-delà, l'arbre de la sous-commande (node + ses Chrome) est tué
// (taskkill /T sur NOTRE pid, jamais par motif) et la case revient avec timedOut.
function runChild(cmd, a, logPath, timeoutMs = 0) {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} ${cmd} ${a.join(" ")}\n`);
    const p = spawn(cmd, a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const killer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      log.write(`\n=== ${new Date().toISOString()} plafond de ${Math.round(timeoutMs / 1000)} s atteint : arbre du pid ${p.pid} tué\n`);
      spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    }, timeoutMs) : null;
    // Lignes de la sortie qui signalent une perte (LOST-SIGN de view.mjs, CONTEXT_LOST, target crashed, processus GPU…).
    const lostLines = []; let tail = "";
    const scan = (d) => { const lines = (tail + d.toString("utf8")).split(/\r?\n/); tail = lines.pop(); for (const l of lines) if (looksLost(l) && lostLines.length < 20) lostLines.push(l.slice(0, 300)); };
    p.stdout.on("data", (d) => { process.stdout.write(d); log.write(d); scan(d); });
    p.stderr.on("data", (d) => { process.stderr.write(d); log.write(d); scan(d); });
    p.on("close", (code, signal) => { if (killer) clearTimeout(killer); scan("\n"); log.end(); resolve({ code: code ?? (signal ? 128 : 1), lostLines, timedOut }); });
  });
}
function stop(code, line) { journal(line); console.error(line); process.exit(code); }

let launched = 0, contended = 0;
for (const c of todo) {
  const conv = conversion(c.model, c.form);
  if (!conv.ok) { caseLine("SKIP", c, 0, `skipped: ${conv.reason}`); continue; }
  if (args.max != null && launched >= args.max) { journal(`# --max ${args.max} atteint : arrêt avant ${c.key}`); break; }
  launched++;
  const cmd = caseCommand(c, { outDir, expectSha });
  const logPath = abs(`${outDir}/logs/${gpuFileName(c).replace(/\.json$/, "")}.${c.suite}.log`);
  const g0 = guardSize(), t0 = Date.now();
  console.log(`\n=== ${c.key}`);
  const capS = Number(KIT?.caseTimeoutS?.[c.suite] ?? 0);
  const { code, lostLines, timedOut } = await runChild(cmd.cmd, cmd.args, logPath, capS * 1000);
  const ms = Date.now() - t0;
  if (timedOut) {
    // kit v2 : plafond atteint ⟹ TIMEOUT (faite ; le rapport l'affiche « délai de case dépassé »). Le .part éventuel est
    // gardé à part pour diagnostic, jamais pris pour un résultat.
    const part = c.suite === "gpu" ? abs(`${cmd.out}.part`) : null;
    if (part && existsSync(part)) renameSync(part, abs(cmd.out.replace(/\.json$/, ".timeout.json")));
    caseLine("TIMEOUT", c, ms, `plafond de case ${capS} s atteint : sous-commande arrêtée (arbre tué), case comptée faite`);
    continue;
  }
  // Revue finale C3 : le garde-fou écrit son journal APRÈS avoir tué les processus (Stop-Process, puis Out-File) :
  // 2 s de grâce avant de lire sa taille, sinon un arrêt RAM serait pris pour une perte.
  await sleep(2000);
  const ramKill = guardSize() > g0;
  const part = c.suite === "gpu" ? abs(`${cmd.out}.part`) : null;
  const res = part ? readJson(part) : null;
  // open : view.mjs a fusionné ses enregistrements dans open.json ; on ne juge que ceux de cette exécution.
  const recs = c.suite === "open" ? openRecords(c).filter((r) => Date.parse(r.at) >= t0 - 1000) : [];
  const d = classifyCase({ suite: c.suite, machine: args.machine, code, ramKill, lostLines, res, recs, openComplete: c.suite === "open" && openComplete(c), refAdapter });
  if (part && d.suffix != null && existsSync(part)) renameSync(part, abs(d.suffix === "" ? cmd.out : cmd.out.replace(/\.json$/, `${d.suffix}.json`)));
  caseLine(d.status, c, ms, d.detail);
  if (d.stop) stop(d.stop, `STOP ${d.status === "LOST" ? "device lost" : `adaptateur ≠ ${args.machine}`} at ${c.key}`);
  // Important 3 : une case contended n'est pas faite ; deux de suite ⟹ arrêt (un autre banc mesure en même temps).
  const k = contendedStreak(contended, d.status); contended = k.streak;
  if (k.stop) stop(5, `STOP deux cases contended de suite (dernière : ${c.key}) : un autre Chrome du banc mesure ; relancer quand il a fini`);
}
journal(`# ${new Date().toISOString()} FIN rebench --machine ${args.machine}`);
process.exit(0);
