// LOCAL ONLY (rebench tâche 5) : verrou « une mesure à la fois » du banc, extrait de scripts/view.mjs (qui n'est pas
// modifié) et compatible avec lui : même fichier results/view/.view.lock, même format (trois lignes : pid, date ISO,
// description), même création exclusive (flag "wx"), même reprise d'un verrou dont le pid est mort. view.mjs et les
// sondes qui utilisent cette lib s'excluent donc mutuellement.
//   const release = await acquireBenchLock("gpu-path-probe scenoptic-rb sixty5");  …  release();
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { root } from "./paths.mjs";

export const BENCH_LOCK_PATH = process.env.BENCH_LOCK_PATH ?? join(root, "results", "view", ".view.lock");

/** Vrai si le processus pid existe (signal 0). */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Contenu du verrou : { pid, since, tag } ; null s'il n'existe pas ou est illisible. */
export function readBenchLock(path = BENCH_LOCK_PATH) {
  try { const [pid, since, tag] = readFileSync(path, "utf8").split("\n"); return { pid: Number(pid), since: since ?? "", tag: tag ?? "" }; } catch { return null; }
}

/**
 * Attend que le verrou soit libre (propriétaire vivant ⟹ attente ; mort ⟹ verrou repris), l'écrit pour ce processus
 * et renvoie la fonction de libération (idempotente, aussi appelée à la sortie du processus et sur SIGINT/SIGTERM).
 * Elle ne supprime le fichier que s'il porte encore notre pid.
 * @param {string} tag description de la mesure (3e ligne du fichier, comme les arguments chez view.mjs)
 * @param {{ path?: string, pollMs?: number, onWait?: (owner: {pid:number,since:string,tag:string}) => void }} [opts]
 * @returns {Promise<() => void>}
 */
export async function acquireBenchLock(tag, opts = {}) {
  const path = opts.path ?? BENCH_LOCK_PATH, pollMs = opts.pollMs ?? 5000;
  const onWait = opts.onWait ?? ((o) => console.log(`verrou tenu par pid ${o.pid} (${o.tag}) depuis ${o.since} : attente…`));
  mkdirSync(dirname(path), { recursive: true });
  for (let waited = 0; ; waited++) {
    try {
      writeFileSync(path, [process.pid, new Date().toISOString(), String(tag).replace(/\n/g, " ")].join("\n") + "\n", { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readBenchLock(path);
      if (!owner) continue; // supprimé entre-temps
      if (!isAlive(owner.pid)) { rmSync(path, { force: true }); continue; } // verrou orphelin : repris
      if (waited % 12 === 0) onWait(owner);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    try { if (readFileSync(path, "utf8").startsWith(`${process.pid}\n`)) rmSync(path, { force: true }); } catch { /* déjà parti */ }
    process.off("exit", release);
  };
  process.on("exit", release);
  for (const s of ["SIGINT", "SIGTERM"]) if (process.listenerCount(s) === 0) process.on(s, () => process.exit(130));
  return release;
}
