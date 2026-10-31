// LOCAL ONLY : profil Chrome jetable sur D: (C: est plein), supprimé à la sortie du processus.
// 24/10 : 500 profils oubliés dans %TEMP% occupaient 53 Go sur C:.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.env.BENCH_TMP ?? "D:/tmp/bench-profiles";
const made = [];
process.on("exit", () => { for (const p of made) try { rmSync(p, { recursive: true, force: true, maxRetries: 5 }); } catch {} });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));

export function benchProfile(prefix) {
  mkdirSync(root, { recursive: true });
  const p = mkdtempSync(join(root, prefix));
  made.push(p);
  return p;
}
