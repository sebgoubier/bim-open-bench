// LOCAL ONLY (kit portable, #865) : profil du « kit portable » du banc, lu dans <racine du banc>/kit.json.
// Sans kit.json (le banc principal), KIT vaut null et rien ne change nulle part.
// Schéma (écrit par scripts/kit.mjs) :
//   { "machine": "auto" | "<nom>",          nom de la machine (libre, /^[a-z0-9][a-z0-9-]{0,40}$/i) ou "auto" (dérivé de
//                                            l'adaptateur et du nom d'hôte par rebench.mjs) ;
//     "quick": true,                        mode rapide : sans IFC brut de xeokit, sans lignes secondaires (Lambert),
//                                            une seule répétition gpu partout ; les passes à effets restent ;
//     "models": ["sixty5", …],              maquettes par défaut de la chaîne ;
//     "forms": { "<tool>": ["sgpuq"] },     formes d'un viewer à la place de celles de la matrice ;
//     "expect": { "<forme>": "<sha|version>" }, version de conversion attendue par forme ;
//     "series": "results/rebench/kit",      dossier de série (sous-dossier <machine>/) ;
//   kit v2 (30/10, banc allégé) :
//     "exclude": ["<tool>", …],             viewers retirés de la matrice (toutes suites) ;
//     "noOpen": ["<tool>", …],              viewers sans suite d'ouverture (même chargeur qu'un autre viewer) ;
//     "openRepeat": { "repeat": 2, "warm": 2 }, répétitions de la suite open des formats convertis (IFC brut : 1 + 0) ;
//     "caseTimeoutS": { "open": 1200, "gpu": 600 }, plafond d'une case : sous-commande tuée (arbre) ⟹ TIMEOUT, comptée faite ;
//     "openOncePerHost": true,              ouverture mesurée une seule fois par copie du kit (iGPU et dGPU du même PC) ;
//     "modelTools": { "<maquette>": ["<tool>", …] }, maquette réservée à ces viewers (les autres : hors classement) ;
//     "modelToolsNote": { "<maquette>": "<raison>" } }  raison affichée par le rapport pour les viewers non lancés. 
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./paths.mjs";

export const KIT_PATH = join(root, "kit.json");
export const KIT_DEFAULT_SERIES = "results/rebench/kit";
/** Nom de machine libre accepté avec un kit (en plus de 4090 / igpu). */
export const KIT_MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/i;

/**
 * Valide un profil déjà parsé (lève une erreur lisible) et le renvoie normalisé.
 * @param {object} p
 */
export function normalizeKitProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("kit.json : un objet JSON est attendu");
  const out = { ...p };
  if (out.machine != null && out.machine !== "auto" && !KIT_MACHINE_RE.test(String(out.machine))) throw new Error(`kit.json : machine invalide « ${out.machine} » (auto, ou ${KIT_MACHINE_RE})`);
  if (out.models != null && (!Array.isArray(out.models) || out.models.some((m) => typeof m !== "string"))) throw new Error("kit.json : models doit être une liste de chaînes");
  for (const k of ["forms", "expect"]) if (out[k] != null && (typeof out[k] !== "object" || Array.isArray(out[k]))) throw new Error(`kit.json : ${k} doit être un objet`);
  for (const [tool, forms] of Object.entries(out.forms ?? {})) if (!Array.isArray(forms) || !forms.length || forms.some((f) => typeof f !== "string")) throw new Error(`kit.json : forms.${tool} doit être une liste non vide de formes`);
  for (const k of ["exclude", "noOpen"]) if (out[k] != null && (!Array.isArray(out[k]) || out[k].some((t) => typeof t !== "string"))) throw new Error(`kit.json : ${k} doit être une liste de chaînes`);
  if (out.openRepeat != null && !(Number.isInteger(out.openRepeat.repeat) && out.openRepeat.repeat >= 1 && Number.isInteger(out.openRepeat.warm) && out.openRepeat.warm >= 0)) throw new Error("kit.json : openRepeat = { repeat ≥ 1, warm ≥ 0 } entiers");
  if (out.caseTimeoutS != null && (typeof out.caseTimeoutS !== "object" || Object.values(out.caseTimeoutS).some((v) => !(Number(v) > 0)))) throw new Error("kit.json : caseTimeoutS = { open, gpu } en secondes > 0");
  out.quick = !!out.quick;
  out.series = typeof out.series === "string" && out.series ? out.series : KIT_DEFAULT_SERIES;
  return out;
}

/** Lit kit.json (null s'il n'existe pas). */
export function readKitProfile(path = KIT_PATH) {
  if (!existsSync(path)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); }
  catch (e) { throw new Error(`kit.json illisible (${path}) : ${e.message}`); }
  return normalizeKitProfile(raw);
}

/** Profil du kit de CE banc (null sur le banc principal). */
export const KIT = readKitProfile();
