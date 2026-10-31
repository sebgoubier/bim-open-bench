// LOCAL ONLY (never pushed). Matrices de Sixty5 pour charger les viewers : le bâtiment seul (7 disciplines, sans le
// contexte urbain) répété N fois en grille presque carrée. Une pièce d'assemblage = { id, offset: [x, y, z] } (m,
// monde Y-up des viewers) ; les panes appliquent le décalage (contrat `offsets`).
//   node scripts/add-sixty5-matrix.mjs <pasX> <pasZ>      pas = emprise du bâtiment + écart (m)
import { readFileSync, writeFileSync } from "node:fs";
import { manifestPath } from "./lib/paths.mjs";

const [sx, sz] = process.argv.slice(2).map(Number);
if (!(sx > 0 && sz > 0)) { console.error("usage: add-sixty5-matrix.mjs <pasX> <pasZ>"); process.exit(2); }
const building = ["sixty5", "sixty5-kitchens", "sixty5-structure", "sixty5-electrical", "sixty5-mechanical", "sixty5-plumbing", "sixty5-space"];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bytesOf = (id) => manifest.models.find((m) => m.id === id).bytes;
const credit = "Sixty5, buildingSMART International Community-Sample-Test-Files (SDK - S1), CC BY 4.0";
const put = (entry) => { const i = manifest.models.findIndex((m) => m.id === entry.id); if (i >= 0) manifest.models[i] = entry; else manifest.models.push(entry); };
for (const n of [1, 2, 4, 8, 16]) {
  const cols = Math.ceil(Math.sqrt(n));
  const parts = [];
  for (let k = 0; k < n; k++) {
    const offset = [(k % cols) * sx, 0, Math.floor(k / cols) * sz];
    for (const id of building) parts.push(k === 0 ? id : { id, offset });
  }
  const id = n === 1 ? "sixty5-building" : `sixty5-x${n}`;
  const title = n === 1 ? "Sixty5 building (7 files, no context)" : `Sixty5 building ×${n} (matrix, ${n * building.length} files)`;
  put({ id, title, parts, licence: "CC-BY-4.0", attribution: credit, facts: {}, bytes: parts.reduce((t, p) => t + bytesOf(p.id ?? p), 0) });
  console.log(id, parts.length, "files");
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
