// LOCAL ONLY (never pushed). Adds the full Sixty5 assembly (11 IFC files from buildingSMART's S1
// sample) to the corpus: one manifest model per file ("partOf": "sixty5-full"), plus the assembly
// "sixty5-full" whose "parts" list them. sixty5 (the architecture file) is already there.
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readIfcSchema } from "./lib/ifc-header.mjs";
import { manifestPath } from "./lib/paths.mjs";

// Dossier des IFC de l'échantillon S1, téléchargés depuis https://github.com/buildingsmart-community/Community-Sample-Test-Files
// (« IFC 2.3.0.1 (IFC 2x3)/SDK - S1 ») : node scripts/add-sixty5-assembly.mjs <dossier>, ou SIXTY5_DIR.
const src = process.argv[2] ?? process.env.SIXTY5_DIR;
if (!src) { console.error("usage : node scripts/add-sixty5-assembly.mjs <dossier des IFC Sixty5 S1>"); process.exit(2); }
const parts = [
  ["sixty5", "O-S1-BWK-BIM architectural - BIM bouwkundig", "architecture"],
  ["sixty5-kitchens", "O-S1-BWK-BIM kitchens total - BIM keukens totaal", "kitchens"],
  ["sixty5-structure", "O-S1-CON-Structural engineering - Constructie", "structure"],
  ["sixty5-electrical", "O-S1-INS-E Installatie", "electrical"],
  ["sixty5-mechanical", "O-S1-INS-W Installatie", "mechanical"],
  ["sixty5-plumbing", "O-S1-INS-Plumbing - Sanitair", "plumbing"],
  ["sixty5-space", "O-S1-INS-Occupied space - Ruimtebeslag", "occupied space"],
  ["sixty5-context-3dbag", "OMG_KS_3dBAG", "context: 3D BAG buildings"],
  ["sixty5-context-vegetation", "OMG_KS_BGT-Vegetatieobject", "context: vegetation"],
  ["sixty5-context-zoning", "OMG_KS_Ruimtelijkeplannen-Enkelbestemming", "context: zoning"],
  ["sixty5-context-origin", "OMG_KS_GEO-Nulpunt", "context: survey origin"],
];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const credit = "Sixty5, buildingSMART International Community-Sample-Test-Files (SDK - S1), CC BY 4.0";
for (const [id, name, what] of parts) {
  const from = join(src, `${name}.ifc`);
  const to = join("models/cache", `${id}.ifc`);
  if (!existsSync(to)) copyFileSync(from, to);
  if (id === "sixty5") continue; // already in the manifest, byte-identical
  const entry = {
    id, title: `Sixty5 ${what}`, partOf: "sixty5-full",
    source: { local: `${name}.ifc` }, licence: "CC-BY-4.0", attribution: credit,
    sha256: sha(to), bytes: statSync(to).size, schema: readIfcSchema(to), facts: {},
  };
  const i = manifest.models.findIndex((m) => m.id === id);
  if (i >= 0) manifest.models[i] = entry; else manifest.models.push(entry);
  console.log(id, entry.bytes, entry.schema);
}
const full = {
  id: "sixty5-full", title: "Sixty5 full assembly (11 files)", parts: parts.map((p) => p[0]),
  licence: "CC-BY-4.0", attribution: credit, facts: {},
};
full.bytes = full.parts.reduce((s, p) => s + manifest.models.find((m) => m.id === p).bytes, 0);
const j = manifest.models.findIndex((m) => m.id === full.id);
if (j >= 0) manifest.models[j] = full; else manifest.models.push(full);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("sixty5-full", full.bytes);
