#!/usr/bin/env node
// LOCAL ONLY (rebench tâche 9) : génère le rapport HTML du rebench concurrents à partir de l'arborescence de la chaîne.
//   node scripts/rebench-report.mjs [--series results/rebench/2026-10-rebench] [--extra <dir>]... [--out <fichier.html>]
// Lit <series>/<machine>/{open.json, gpu/*.json, journal.log, shots/} et <series>/models.json. --extra <dir> ajoute
// les sorties gpu-path-probe d'un dossier (ex. results/view/2026-10-2x-rebench/t5), la machine étant déduite de
// l'adaptateur ; une case de la chaîne prime sur la même case d'un --extra. Les captures (Sixty5 et matrices
// seulement) sont copiées dans report-assets/ à côté du rapport et référencées en chemins relatifs.
// Garde anti-fuite : rien n'est écrit si la page contient un chemin disque, un nom de fichier .ifc, ou une maquette
// non publique hors alias (assertNoLeak).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readManifest } from "./lib/manifest.mjs";
import { root } from "./lib/paths.mjs";
import { adapterMatches } from "./lib/rebench-matrix.mjs";
import { MACHINES, SHOT_TOOLS, assertNoLeak, mainForm, renderReport, shotsAllowed } from "./lib/rebench-report.mjs";
import { applyKitFormAlias, kitFormAlias } from "./lib/rebench-report.mjs"; // local (kit portable)
import { KIT, KIT_MACHINE_RE } from "./lib/kit-profile.mjs"; // local (kit portable)

function parseArgs(argv) {
  const a = { series: "results/rebench/2026-10-rebench", extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--series") a.series = argv[++i];
    else if (k === "--extra") a.extra.push(argv[++i]);
    else if (k === "--out") a.out = argv[++i];
    else { console.error(`argument inattendu : ${k}\nusage : node scripts/rebench-report.mjs [--series <dir>] [--extra <dir>]... [--out <fichier.html>]`); process.exit(2); }
  }
  a.series = resolve(root, a.series);
  a.extra = a.extra.map((d) => resolve(root, d));
  a.out = resolve(root, a.out ?? join(a.series, "report.html"));
  return a;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
// Seuls les résultats définitifs : pas les .part / .lost / .err / .ram / .wrongadapter de rebench.mjs.
const isResultFile = (f) => f.endsWith(".json") && !/\.(part|lost|err|ram|wrongadapter|contended|skip)\.json$/.test(f); // local (rebench) : revue finale, + contended, skip
// local (rebench) : revue finale C6 : dans la série de la chaîne, seuls les fichiers d'une répétition (…--r<k>.json) comptent ;
// local (rebench) : une sortie sans répétition (avant la cadence imposée et les répétitions) est ignorée, avec un avertissement.
const isRepFile = (f) => /--r\d+\.json$/.test(f); // local (rebench)
const adapterText = (a) => (a == null ? null : typeof a === "string" ? a : [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(" "));
const machineOf = (res) => MACHINES.find((m) => adapterMatches(m, adapterText(res?.adapter))) ?? null;

function readJournal(p) {
  const out = { header: [], status: {} };
  if (!existsSync(p)) return out;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (l.startsWith("#")) { out.header.push(l); continue; }
    const m = l.match(/^\S+ (\S+)\s+(\S+)/);
    if (m) out.status[m[2]] = m[1]; // la dernière ligne d'une case l'emporte
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const manifest = readManifest();
const models = readJson(join(args.series, "models.json")) ?? [];
const machines = {};
const shotSources = []; // { machine, res, dir }
const warn = (s) => console.warn(`attention : ${s}`);

for (const mk of MACHINES) {
  const dir = join(args.series, mk);
  if (!existsSync(dir)) { machines[mk] = null; continue; }
  const gpuDir = join(dir, "gpu");
  const files = existsSync(gpuDir) ? readdirSync(gpuDir).filter(isResultFile) : []; // local (rebench)
  for (const f of files.filter((x) => !isRepFile(x))) warn(`${mk}/gpu/${f} : sortie sans répétition (d'avant la revue finale), ignorée`); // local (rebench)
  const gpu = files.filter(isRepFile).map((f) => readJson(join(gpuDir, f))).filter(Boolean); // local (rebench) : répétitions seulement
  for (const r of gpu) { if (machineOf(r) && machineOf(r) !== mk) warn(`${mk}/gpu : ${r.tool} ${r.model} relevé sur un autre adaptateur, ignoré`); else shotSources.push({ machine: mk, res: r, dir: join(dir, "shots") }); }
  machines[mk] = { gpu: gpu.filter((r) => !machineOf(r) || machineOf(r) === mk), open: readJson(join(dir, "open.json"))?.runs ?? [], journal: readJournal(join(dir, "journal.log")) };
}

// local (kit portable) : machines importées d'un kit (scripts/kit-import.mjs) : sous-dossier de la série au nom libre qui
// porte adapter.json (adaptateur de référence de la chaîne) ; les autres sous-dossiers (final-fix, t3-captures…) sont ignorés.
const kitMachines = (() => { try { return readdirSync(args.series, { withFileTypes: true }).filter((d) => d.isDirectory() && !MACHINES.includes(d.name) && KIT_MACHINE_RE.test(d.name) && existsSync(join(args.series, d.name, "adapter.json"))).map((d) => d.name).sort(); } catch { return []; } })();
for (const mk of kitMachines) {
  const dir = join(args.series, mk);
  const ref = readJson(join(dir, "adapter.json"));
  const gpuDir = join(dir, "gpu");
  const files = existsSync(gpuDir) ? readdirSync(gpuDir).filter(isResultFile).filter(isRepFile) : [];
  const all = files.map((f) => readJson(join(gpuDir, f))).filter(Boolean);
  const gpu = all.filter((r) => !r.adapter || adapterMatches(mk, adapterText(r.adapter), ref));
  if (gpu.length < all.length) warn(`${mk}/gpu : ${all.length - gpu.length} résultat(s) relevé(s) sur un autre adaptateur que adapter.json, ignoré(s)`);
  machines[mk] = { gpu, open: readJson(join(dir, "open.json"))?.runs ?? [], journal: readJournal(join(dir, "journal.log")) };
  const moved = applyKitFormAlias(machines[mk], kitFormAlias(readJson(join(dir, "kit.json")) ?? KIT)); // kit.json importé, sinon celui du kit (rapport fait sur le kit)
  for (const l of moved) console.log(`${mk} (kit) : ${l}`);
  for (const r of gpu) shotSources.push({ machine: mk, res: r, dir: join(dir, "shots") });
}

for (const dir of args.extra) {
  if (!existsSync(dir)) { warn(`--extra ${relative(root, dir)} absent`); continue; }
  for (const f of readdirSync(dir).filter(isResultFile)) {
    const r = readJson(join(dir, f));
    if (!r?.tool || !r.model || !r.form) continue;
    const mk = machineOf(r);
    if (!mk) { warn(`${f} : adaptateur inconnu, ignoré`); continue; }
    machines[mk] ??= { gpu: [], open: [], journal: { header: [], status: {} } };
    const m = machines[mk];
    if (m.gpu.some((x) => x.tool === r.tool && x.form === r.form && x.model === r.model)) continue; // la chaîne prime
    r.__source = basename(dir); // affiché sous la case : mesure hors chaîne
    m.gpu.push(r);
    shotSources.push({ machine: mk, res: r, dir: join(dir, "shots") });
  }
}

// Captures : Sixty5 et matrices seulement, panes de la planche, forme principale ; copiées dans report-assets/<machine>/.
const outDir = dirname(args.out);
const assetsDir = join(outDir, "report-assets");
const shots = [];
for (const { machine, res, dir } of shotSources) {
  if (!shotsAllowed(res.model) || !SHOT_TOOLS.includes(res.tool) || res.form !== mainForm(res.tool) || !existsSync(dir)) continue;
  const prefix = `${res.tool}-${res.model}-${res.kitForm ?? res.form}-`; // local (kit portable) : fichiers à la forme mesurée
  for (const f of readdirSync(dir)) {
    const m = f.startsWith(prefix) && f.slice(prefix.length).match(/^(t\d+s)\.png$/); // les 11 points de vue, pas les images en mouvement
    if (!m || shots.some((s) => s.machine === machine && s.tool === res.tool && s.model === res.model && s.vp === m[1])) continue;
    shots.push({ machine, model: res.model, tool: res.tool, form: res.form, vp: m[1], src: join(dir, f), href: `report-assets/${machine}/${f}` });
  }
}

const html = renderReport({ machines, models, shots, generated: new Date().toISOString().slice(0, 16).replace("T", " ") });
try { assertNoLeak(html, manifest); }
catch (e) { console.error(e.message); process.exit(1); }

mkdirSync(outDir, { recursive: true });
for (const s of shots) { mkdirSync(join(assetsDir, s.machine), { recursive: true }); copyFileSync(s.src, join(assetsDir, s.machine, basename(s.src))); }
writeFileSync(args.out, html);
const count = (mk) => (machines[mk] ? `${machines[mk].gpu.length} gpu, ${machines[mk].open.length} enregistrements open` : "rien");
console.log(`rapport : ${relative(root, args.out)} (${Math.round(html.length / 1024)} Ko) ; ${[...MACHINES, ...kitMachines].map((mk) => `${mk} : ${count(mk)}`).join(" ; ")} ; ${shots.length} captures copiées dans ${relative(root, assetsDir)}`);
