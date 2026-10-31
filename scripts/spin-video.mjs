// LOCAL ONLY (never pushed). Vidéo du « trajet 2 » (site/solo.mjs) : caméra au centre de la maquette, rotation sur
// elle-même. Chaque viewer est filmé SEUL (pas de concurrence pour le GPU), puis les clips sont mis côte à côte : la
// rotation suit l'horloge murale, et chaque clip est coupé à la première image qui bouge (filtre freezedetect), donc
// les viewers ont le même angle à la même image de la vidéo finale.
//
//   node scripts/spin-video.mjs --model sixty5-x4 --tools scenoptic-webgpu-rb:sgpuq,thatopen:frag [--speed 90] [--secs 12]
//        [--el 0] [--h 0] [--size 1280x720] [--out results/spin-video/<nom>] [--keep-open]
//
// Prend le verrou du banc (scripts/lib/bench-lock.mjs). Chrome garde la vsync (vidéo à la cadence réelle de l'écran).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireBenchLock } from "./lib/bench-lock.mjs";
import { root } from "./lib/paths.mjs";
import { startServer } from "./serve.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const model = arg("--model", "sixty5-x4");
const tools = arg("--tools", "scenoptic-webgpu-rb:sgpuq,thatopen:frag").split(",").map((s) => { const [tool, form] = s.split(":"); return { tool, form }; });
const speed = Number(arg("--speed", 90)), secs = Number(arg("--secs", 12)), el = Number(arg("--el", 0)), h = Number(arg("--h", 0));
const [W, H] = arg("--size", "1280x720").split("x").map(Number);
const port = Number(arg("--port", 8791));
const out = resolve(root, arg("--out", join("results", "spin-video", `${model}-${speed}dps`)));
const keepOpen = argv.includes("--keep-open");
// --gpu igpu|dgpu : préférence graphique Windows de chrome.exe, comme scripts/kit-run.cmd (rétablie à la fin, même en cas d'erreur)
const gpuWanted = arg("--gpu", null);
const warm = argv.includes("--warm");
const chromePath = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

// --- CDP minimal ---
async function cdpPage(debugPort) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) return connect(page.webSocketDebuggerUrl);
    } catch { /* Chrome démarre */ }
    await sleep(200);
  }
  throw new Error("Chrome ne répond pas");
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return new Promise((ok) => { ws.onopen = () => ok({ send, evaluate, close: () => ws.close() }); });
}

// Fenêtre de Chrome au premier plan et au-dessus des autres (la capture du bureau filme ce qui est visible).
function topmost(pid) {
  const ps = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';
$h = (Get-Process -Id ${pid}).MainWindowHandle; if ($h -ne 0) { [U.W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 3) | Out-Null; [U.W]::SetForegroundWindow($h) | Out-Null; "ok" } else { "pas de fenêtre" }`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (!/ok/.test(r.stdout)) console.log(`  premier plan : ${(r.stdout + r.stderr).trim()}`);
}

const GPU_KEY = String.raw`HKCU:\Software\Microsoft\DirectX\UserGpuPreferences`;
function gpuPref(value) { // value = "GpuPreference=1;" (iGPU), "GpuPreference=2;" (GPU dédié), null = supprimer ; rend l'ancienne valeur
  const ps = `$k='${GPU_KEY}'; $n='${chromePath.replace(/\//g, "\\")}'; if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null };
$o=(Get-ItemProperty $k -Name $n -ErrorAction SilentlyContinue).$n; if ($null -eq $o) { $o='<absent>' }; Write-Output $o;
${value === undefined ? "" : value === null ? "Remove-ItemProperty $k -Name $n -ErrorAction SilentlyContinue" : `Set-ItemProperty $k -Name $n -Value '${value}'`}`;
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout.trim();
}

function probe(file) { // début de la rotation : le repère #sync de solo.html (coin haut gauche) passe du noir au blanc
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-vf", "crop=8:8:2:2,blackdetect=d=0.2:pix_th=0.5:pic_th=0.9", "-map", "0:v", "-f", "null", "-"], { encoding: "utf8" });
  const m = /black_end:([\d.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}

// --montage-only : refait le montage depuis clips.json, sans rien filmer
const montageOnly = argv.includes("--montage-only");
const release = montageOnly ? () => {} : await acquireBenchLock(`spin-video ${model} ${tools.map((t) => t.tool).join(",")}`);
let gpuOld = null;
if (gpuWanted && !montageOnly) { gpuOld = gpuPref(gpuWanted === "igpu" ? "GpuPreference=1;" : "GpuPreference=2;"); console.log(`préférence GPU de Chrome : ${gpuWanted} (avant : ${gpuOld})`); }
const server = montageOnly ? { close() {} } : await startServer(port);
const clips = montageOnly ? JSON.parse(readFileSync(join(out, "clips.json"), "utf8")).clips : [];
try {
  if (!montageOnly) for (const [k, { tool, form }] of tools.entries()) {
    const debugPort = 9400 + k, profile = join(root, "tmp", `spin-profile-${k}`);
    rmSync(profile, { recursive: true, force: true });
    const q = new URLSearchParams({ tool, model, form, bare: "1", spinSpeed: String(speed), spinEl: String(el), spinH: String(h), spinS: String(secs), topEl: arg("--top-el", "60"), topDist: arg("--top-dist", "1.4"), ...(arg("--orbit") ? { orbit: arg("--orbit"), orbitEl: arg("--orbit-el", "15") } : {}) });
    const url = `http://localhost:${port}/site/solo.html?${q}`;
    const chrome = spawn(chromePath, [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--force_high_performance_gpu", "--force-device-scale-factor=1",
      "--window-position=0,0", `--window-size=${W},${H}`, `--app=${url}`], { stdio: "ignore" });
    const page = await cdpPage(debugPort);
    for (let i = 0; !(await page.evaluate("window.__soloReady?.() === true")); i++) { if (i > 120) throw new Error(`${tool} : viewer pas prêt`); await sleep(500); }
    if (warm) { // --warm : un premier chargement non filmé remplit les caches (HTTP, IndexedDB d'IFClite), puis page neuve
      await page.evaluate("window.__soloLoad()");
      for (let i = 0; !(await page.evaluate("window.__soloLoaded?.() === true")); i++) { if (i > 1200) throw new Error(`${tool} : premier chargement trop long`); await sleep(500); }
      await sleep(4000); // écritures de cache en fond (IFClite écrit après la géométrie)
      await page.send("Page.reload", { ignoreCache: false });
      await sleep(1500);
      for (let i = 0; !(await page.evaluate("window.__soloReady?.() === true")); i++) { if (i > 120) throw new Error(`${tool} : viewer pas prêt après rechargement`); await sleep(500); }
      console.log(`${tool} : caches remplis, prise à chaud`);
    }
    if (gpuWanted) { // refuse de filmer sur le mauvais GPU
      const name = await page.evaluate(`document.getElementById("status")?.textContent?.match(/^\[([^\]]+)\]/)?.[1] ?? ""`);
      if ((gpuWanted === "igpu") === /nvidia/i.test(name)) throw new Error(`${tool} : GPU ${name || "?"} au lieu de ${gpuWanted}`);
    }
    topmost(chrome.pid);
    await sleep(1000);
    const file = join(out, `${String(k + 1).padStart(2, "0")}-${tool}.mp4`);
    // Zone cliente de la fenêtre, en pixels du bureau (Desktop Duplication : la capture par fenêtre de Windows rend le
    // contenu GPU de Chrome en noir). Bordures invisibles de Windows 11 = (outerWidth - innerWidth) / 2 de chaque côté.
    const g = JSON.parse(await page.evaluate(`JSON.stringify({ x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })`));
    const bx = (g.ow - g.iw) / 2, ox = Math.round((g.x + bx) * g.dpr), oy = Math.round((g.y + g.oh - g.ih - bx) * g.dpr);
    const vw = Math.floor((g.iw * g.dpr) / 2) * 2, vh = Math.floor((g.ih * g.dpr) / 2) * 2;
    // Filmé du chargement (cache vide, profil neuf) jusqu'à la fin de la rotation ; arrêt par « q » sur l'entrée de ffmpeg.
    const rec = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `ddagrab=output_idx=0:framerate=60:draw_mouse=0:offset_x=${ox}:offset_y=${oy}:video_size=${vw}x${vh},hwdownload,format=bgra`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"] });
    await sleep(1200);
    topmost(chrome.pid); // de nouveau : une fenêtre apparue entre-temps ne doit pas masquer le chargement
    await page.evaluate("window.__soloLoad()"); // t = 0 : le repère #sync passe au blanc
    const t0 = Date.now();
    const keepTop = setInterval(() => topmost(chrome.pid), 2000); // une fenêtre peut surgir pendant un long chargement
    for (;;) {
      if (await page.evaluate("window.__soloLoaded?.() === true")) break;
      const st = await page.evaluate(`document.getElementById("status")?.textContent ?? ""`);
      if (/failed/.test(st)) { console.log(`${tool} : échec du chargement · ${st.slice(0, 240)}`); break; }
      if (Date.now() - t0 > 600_000) throw new Error(`${tool} : maquette pas chargée en 10 min`);
      await sleep(100);
    }
    if (!(await page.evaluate("window.__soloLoaded?.() === true"))) { rec.stdin.write("q"); await new Promise((ok) => rec.on("exit", ok)); clearInterval(keepTop); page.close(); chrome.kill(); await sleep(1500); continue; }
    const loadS = (Date.now() - t0) / 1000;
    console.log(`${tool} chargé en ${loadS.toFixed(1)} s · ${await page.evaluate(`document.getElementById("status")?.textContent?.slice(0, 140)`)}`);
    await page.evaluate("window.__spinPlace()"); // au centre, puis rotation une demi-seconde plus tard
    const res = await page.evaluate(`window.__spin(Date.now() + 500)`);
    await sleep(500);
    rec.stdin.write("q");
    await new Promise((ok) => rec.on("exit", ok));
    clearInterval(keepTop);
    console.log(`${tool} : ${JSON.stringify(res)}`);
    clips.push({ tool, file, start: probe(file), loadS, res });
    if (!keepOpen) { page.close(); chrome.kill(); await sleep(1500); }
  }
} finally {
  server.close();
  release();
  if (gpuOld != null) { gpuPref(gpuOld === "<absent>" ? null : gpuOld); console.log(`préférence GPU de Chrome rétablie : ${gpuOld}`); }
}

// Trajet (site/solo.mjs) : vue d'ensemble 1,5 s, descente 3 s, rotation --secs.
// Montage : chaque clip part de t = 0 (envoi du chargement, repère #sync), chronomètre et nom en surimpression ; un clip
// plus court se fige sur sa dernière image jusqu'à la fin du plus long.
const ok = clips.filter((c) => c.start != null);
writeFileSync(join(out, "clips.json"), JSON.stringify({ model, speed, secs, el, h, size: [W, H], clips }, null, 2));
const LABEL = { "scenoptic-webgpu-rb": "Scenoptic (WebGPU)", thatopen: "That Open (WebGL)", "thatopen-webgpu": "That Open (WebGPU)", xeokit: "xeokit", ifclite: "IFClite", "bim-open-viewer": "BIM Open Viewer" };
if (warm) for (const k of Object.keys(LABEL)) LABEL[k] += " · à chaud";
const FONT = "font.ttf"; // copiée dans le dossier de sortie : chemin relatif, sans « C: » à échapper dans le filtre
copyFileSync("C:/Windows/Fonts/segoeuib.ttf", join(out, FONT));
const CLOCK = String.raw`%{eif\:max(0\,t-0.3)\:d}.%{eif\:mod(max(0\,t-0.3)*10\,10)\:d} s`;
function montage(list, name) {
  const lens = list.map((c) => c.loadS + 0.5 + (c.res?.ms ?? secs * 1000) / 1000 + 0.3); // chargement + trajet complet
  const total = Math.max(...lens);
  const inputs = list.flatMap((c) => ["-ss", String(Math.max(0, c.start - 0.3)), "-i", c.file]);
  const grid = list.length === 4, cellW = grid ? 960 : Math.round(1920 / list.length / 2) * 2;
  const chains = list.map((c, i) => `[${i}:v]setpts=PTS-STARTPTS,trim=duration=${lens[i].toFixed(2)},crop=iw:ih-16:0:16,scale=${cellW}:-2,setsar=1,` +
    `tpad=stop_mode=clone:stop_duration=${(total - lens[i] + 0.1).toFixed(2)},` +
    `drawtext=fontfile='${FONT}':text='${LABEL[c.tool] ?? c.tool}':x=14:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8,` +
    `drawtext=fontfile='${FONT}':text='${CLOCK}':x=w-tw-14:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8[v${i}]`).join(";");
  const join = grid ? `[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]` : `${list.map((_, i) => `[v${i}]`).join("")}hstack=inputs=${list.length}[v]`;
  const final = join_(out, `${name}.mp4`);
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", `${chains};${join}`, "-map", "[v]", "-t", total.toFixed(2), "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], { stdio: "inherit", cwd: out });
  console.log(r.status === 0 && existsSync(final) ? `vidéo : ${final}` : `montage en échec : ${name}`);
}
const join_ = join;
if (ok.length >= 2) {
  const base = `${model}-${speed}dps`;
  montage(ok, `${base}-${ok.length === 4 ? "grille" : ok.map((c) => c.tool).join("+")}`);
  // Scenoptic face à chaque concurrent, pour que chacun ait sa comparaison à deux
  const me = ok.find((c) => c.tool.startsWith("scenoptic"));
  if (me && ok.length > 2) for (const c of ok.filter((c) => c !== me)) montage([me, c], `${base}-${me.tool}+${c.tool}`);
} else console.log(`clips sans repère détecté : ${clips.filter((c) => c.start == null).map((c) => c.tool).join(", ") || "-"}`);
