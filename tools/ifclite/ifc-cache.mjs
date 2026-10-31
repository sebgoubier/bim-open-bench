// local (rebench, 26/10) : le cache de géométrie du viewer ifc-lite, porté tel quel pour le pane (MPL-2.0, LTplus AG).
// Le viewer officiel (clone C:/dev/ifc-lite, commit 62e41d57e du 06/09, apps/viewer/src) garde dans IndexedDB la
// géométrie et le modèle de données déjà calculés ; le pane n'appelle que ses paquets, ce module recopie donc la
// colle de l'application, sans rien inventer. Sources, dans le clone :
//   - seuils          utils/ifcConfig.ts:46 (10 Mio), :53 (150 Mio), :72 (400 Mio) ;
//   - palier          hooks/cacheTier.ts:57-77 (classifyCacheTier, planCacheWrite) ; mesh-only ACTIVÉ par défaut,
//                     coupé seulement par ?meshCache=0 : store/constants.ts:198-230 (aucun drapeau ici ⟹ activé) ;
//   - clé             hooks/geometryCacheKey.ts:46-56 ; empreinte hooks/sourceFingerprint.ts (devenue
//                     computeSourceFingerprint de @ifc-lite/cache, même algorithme) ; options : hooks/useIfcLoader.ts:1069-1118 ;
//   - validation      hooks/cacheTier.ts:98-108 (decideMeshOnlyCacheHit), utils/sourceContentHash.ts (SHA-256) ;
//   - IndexedDB       services/ifc-cache.ts (base « ifc-lite-cache » v1, magasin « models », plafond 1,5 Gio, marge 128 Mio,
//                     éviction des plus anciennes) ;
//   - lecture         hooks/useIfcCache.ts:183-508 (loadFromCache) ; écriture : :513-578 (saveToCache) ;
//   - cartes          utils/spatialHierarchy.ts:306-422 (rebuildOnDemandMaps), utils/materialDefinitionTypes.ts,
//                     utils/localParsingUtils.ts:229-249 (calculateStoreyHeights).
// Paquet : @ifc-lite/cache 3.7.0, la version publiée qui accompagne @ifc-lite/geometry 7.7.0 et @ifc-lite/data 6.3.0
// (3.7.2 exige geometry ^7.8.1). FORMAT_VERSION y vaut 23 (18 dans le clone : le format a avancé, la colle non).
import {
  BinaryCacheReader, BinaryCacheWriter, BufferReader, FORMAT_VERSION, SchemaVersion, SectionType, computeSourceFingerprint,
  openGeometryChunksV13, readInstancedShards, toCacheDataStore,
} from "@ifc-lite/cache";
import { CompactEntityIndex, SpatialHierarchyBuilder, asSourceBytes, attachDataStoreAccessors, extractLengthUnitScale } from "@ifc-lite/parser";
import { RelationshipType } from "@ifc-lite/data";

const MiB = 1024 * 1024;
// utils/ifcConfig.ts:46,53,72
export const CACHE_SIZE_THRESHOLD = 10 * MiB;
export const CACHE_MAX_SOURCE_SIZE = 150 * MiB;
export const CACHE_MESH_ONLY_MAX_SIZE = 400 * MiB;

/**
 * Palier d'un modèle PRINCIPAL selon sa taille (hooks/cacheTier.ts:57-77, mesh-only activé : leur défaut).
 * @returns {{ tier: "none"|"source"|"mesh-only", shouldCache: boolean, persistSource: boolean, reason: string }}
 */
export function planCache(byteLength, meshOnlyEnabled = true) {
  let tier = "source", reason = "10-150 Mio : géométrie + source en cache";
  if (byteLength < CACHE_SIZE_THRESHOLD) { tier = "none"; reason = "pas de cache : < 10 Mo"; }
  else if (byteLength <= CACHE_MAX_SOURCE_SIZE) { /* source */ }
  else if (meshOnlyEnabled && byteLength <= CACHE_MESH_ONLY_MAX_SIZE) { tier = "mesh-only"; reason = "150-400 Mio : géométrie seule (mesh-only), source relue"; }
  else { tier = "none"; reason = "pas de cache : > 400 Mo"; }
  return { tier, shouldCache: tier !== "none", persistSource: tier === "source", reason };
}

/**
 * Clé du cache (hooks/geometryCacheKey.ts:46-56) : taille + empreinte échantillonnée + version de format, plus les
 * options de tessellation hors défaut. Le pane construit son GeometryProcessor sans option : mergeLayers false,
 * skipSmallCuts false, tessellationQuality null (medium), donc aucun suffixe. (Leur viewer, en mode « fast » par défaut,
 * ajoute « -sc » et, dès 50 Mio, « -tlow » : sa géométrie n'est pas celle du pane, sa clé non plus.)
 */
export function geometryCacheKey(bytes, { mergeLayers = false, skipSmallCuts = false, tessellationTier } = {}) {
  const fingerprint = computeSourceFingerprint(bytes);
  const tier = tessellationTier && tessellationTier !== "medium" ? `-t${tessellationTier}` : "";
  return { key: `ifc-${bytes.byteLength}-${fingerprint.hex}-v${FORMAT_VERSION}${mergeLayers ? "-ml" : ""}${skipSmallCuts ? "-sc" : ""}${tier}`, fingerprint: fingerprint.hex };
}

/** hooks/cacheTier.ts:98-108 */
export function decideMeshOnlyCacheHit({ storedMtime, freshMtime, hasFullHash }) {
  const mtimeKnown = !!storedMtime && !!freshMtime;
  if (mtimeKnown && storedMtime !== freshMtime) return "miss";
  if (!mtimeKnown && !hasFullHash) return "miss";
  return "serve";
}

/** utils/sourceContentHash.ts : SHA-256 de tout le fichier (Web Crypto, hors du fil principal), null sans Web Crypto. */
export async function computeFullSourceHash(source) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) return null;
  try {
    const u8 = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
    const bytes = u8.buffer instanceof ArrayBuffer ? u8 : Uint8Array.from(u8);
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    let out = "";
    for (const b of digest) out += b.toString(16).padStart(2, "0");
    return out;
  } catch (err) {
    console.warn("[source-hash] full-file hash failed; skipping revalidation", err);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB (services/ifc-cache.ts)

const DB_NAME = "ifc-lite-cache", DB_VERSION = 1, STORE_NAME = "models";
export const PER_ENTRY_MAX_BYTES = 1.5 * 1024 * MiB;
export const QUOTA_HEADROOM_BYTES = 128 * MiB;
let dbPromise = null;

const entryBytes = (buffer, sourceBuffer) => (buffer instanceof Blob ? buffer.size : buffer.byteLength) + (sourceBuffer?.byteLength ?? 0);

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("fileName", "fileName", { unique: false });
      }
    };
  });
  return dbPromise;
}

async function availableQuotaBytes() {
  try {
    if (navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota === "number" && typeof usage === "number") return Math.max(0, quota - usage);
    }
  } catch (err) { console.warn("[IFC Cache] storage.estimate() failed; skipping quota guard", err); }
  return Infinity;
}

function evictToFree(db, targetBytes, keepKey) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.index("createdAt").openCursor();
    const victims = [];
    let cumulative = 0, enough = false;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && cumulative < targetBytes) {
        if (cursor.value.key !== keepKey) { cumulative += entryBytes(cursor.value.buffer, cursor.value.sourceBuffer); victims.push(cursor.primaryKey); }
        cursor.continue();
        return;
      }
      enough = cumulative >= targetBytes;
      if (enough) for (const key of victims) store.delete(key);
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve(enough);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function ensureRoomForEntry(db, bytes, keepKey) {
  if (bytes > PER_ENTRY_MAX_BYTES) { console.warn("[IFC Cache] entry exceeds per-entry ceiling; skipping cache write"); return { ok: false, why: "entrée > 1,5 Gio" }; }
  const available = await availableQuotaBytes();
  if (available === Infinity) return { ok: true };
  const required = bytes + QUOTA_HEADROOM_BYTES;
  if (available >= required) return { ok: true };
  try { if (await evictToFree(db, required - available, keepKey)) return { ok: true, evicted: true }; }
  catch (err) { console.warn("[IFC Cache] LRU eviction failed; skipping cache write", err); return { ok: false, why: "éviction impossible" }; }
  return { ok: false, why: "quota insuffisant" };
}

export async function getCached(key) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => {
        const e = request.result;
        resolve(e ? { buffer: e.buffer, sourceBuffer: e.sourceBuffer, lastModified: e.lastModified, fullSourceHash: e.fullSourceHash } : null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) { console.warn("[IFC Cache] Cache read failed:", err); return null; }
}

export async function deleteCached(key) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) { console.warn("[IFC Cache] Failed to delete cache entry:", err); }
}

/** services/ifc-cache.ts setCached : la valeur est rangée en Blob (adossé au disque), la source en ArrayBuffer. */
async function setCached(key, buffer, fileName, fileSize, sourceBuffer, meta) {
  try {
    const db = await openDatabase();
    const room = await ensureRoomForEntry(db, entryBytes(buffer, sourceBuffer), key);
    if (!room.ok) return { ok: false, why: room.why };
    return await new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const tx = db.transaction(STORE_NAME, "readwrite");
      const entry = { key, buffer: new Blob([buffer]), sourceBuffer, fileName, fileSize, createdAt: Date.now(), lastModified: meta?.lastModified, fullSourceHash: meta?.fullSourceHash };
      tx.oncomplete = () => done({ ok: true, evicted: !!room.evicted });
      tx.onabort = () => { console.warn("[IFC Cache] Cache write transaction aborted", tx.error); done({ ok: false, why: `transaction annulée : ${tx.error?.name ?? "?"}` }); };
      tx.onerror = () => done({ ok: false, why: `erreur de transaction : ${tx.error?.name ?? "?"}` });
      try { tx.objectStore(STORE_NAME).put(entry).onerror = () => {}; }
      catch (err) { try { tx.abort(); } catch {} done({ ok: false, why: `put : ${err?.name ?? err}` }); }
    });
  } catch (err) { console.warn("[IFC Cache] Cache write failed:", err); return { ok: false, why: String(err?.message ?? err) }; }
}

// ---------------------------------------------------------------------------------------------------------------
// Écriture (hooks/useIfcCache.ts saveToCache) : appelée par le pane après la géométrie, quand le modèle de données est prêt.

/**
 * @param {string} key
 * @param {object} dataStore le modèle de données du parseur (le même objet que leur viewer passe)
 * @param {{ meshes, totalVertices, totalTriangles, coordinateInfo, instancedShards? }} geometry
 * @param {ArrayBuffer} sourceBuffer le fichier IFC (ArrayBuffer ordinaire : IndexedDB refuse un SharedArrayBuffer)
 * @returns {Promise<{ ok: boolean, why?: string, cacheBytes?: number, writeMs: number, hashMs?: number }>}
 */
export async function saveCacheEntry(key, dataStore, geometry, sourceBuffer, fileName, { persistSource = true, lastModified } = {}) {
  const t0 = performance.now();
  try {
    const writer = new BinaryCacheWriter();
    const cacheDataStore = toCacheDataStore(dataStore);
    // SHA-256 hors du fil principal pour le palier mesh-only seulement (en parallèle de la sérialisation).
    const th = performance.now();
    let hashMs;
    const fullHashPromise = persistSource ? Promise.resolve(null) : computeFullSourceHash(sourceBuffer).then((h) => { hashMs = performance.now() - th; return h; });
    const cacheBuffer = await writer.write(cacheDataStore, geometry, sourceBuffer, { includeGeometry: true, compressGeometryChunksInWorker: true, omitSourceHash: true });
    const fullSourceHash = (await fullHashPromise) ?? undefined;
    const r = await setCached(key, cacheBuffer, fileName, sourceBuffer.byteLength, persistSource ? sourceBuffer : undefined, { lastModified, fullSourceHash });
    return { ...r, cacheBytes: cacheBuffer.byteLength, writeMs: Math.round(performance.now() - t0), hashMs: hashMs == null ? undefined : Math.round(hashMs) };
  } catch (err) {
    console.error("[useIfcCache] Failed to cache model:", err);
    return { ok: false, why: String(err?.message ?? err), writeMs: Math.round(performance.now() - t0) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lecture (hooks/useIfcCache.ts loadFromCache) : le modèle de données est réhydraté AVANT la géométrie, qui arrive
// ensuite morceau par morceau (openGeometryChunksV13 / readChunk).

// utils/materialDefinitionTypes.ts
const MATERIAL_DEF_TYPES = new Set(["IFCMATERIAL", "IFCMATERIALCONSTITUENT", "IFCMATERIALCONSTITUENTSET", "IFCMATERIALLAYER", "IFCMATERIALLAYERSET", "IFCMATERIALLAYERWITHOFFSETS", "IFCMATERIALPROFILE", "IFCMATERIALPROFILESET", "IFCMATERIALPROFILEWITHOFFSETS", "IFCMATERIALLAYERSETUSAGE", "IFCMATERIALPROFILESETUSAGE", "IFCMATERIALPROFILESETUSAGETAPERING", "IFCMATERIALLIST"]);

function buildEntityIndexFromCachedColumns(columns) {
  const byId = new CompactEntityIndex(columns.ids, columns.byteOffsets, columns.byteLengths, columns.typeIndices, columns.typeNames);
  const byType = new Map();
  for (let i = 0; i < columns.ids.length; i++) {
    const type = columns.typeNames[columns.typeIndices[i]];
    let ids = byType.get(type);
    if (!ids) byType.set(type, (ids = []));
    ids.push(columns.ids[i]);
  }
  return { byId, byType };
}

// utils/spatialHierarchy.ts:306-422 (branche entityIndex.byType : c'est toujours le cas ici)
function rebuildOnDemandMaps(entities, relationships, entityIndex) {
  const onDemandPropertyMap = new Map(), onDemandQuantityMap = new Map(), onDemandMaterialMap = new Map();
  const propertySets = entityIndex.byType.get("IFCPROPERTYSET") || entityIndex.byType.get("IfcPropertySet") || [];
  const quantitySets = entityIndex.byType.get("IFCELEMENTQUANTITY") || entityIndex.byType.get("IfcElementQuantity") || [];
  const push = (map, k, v) => { let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(v); };
  for (const psetId of propertySets) for (const e of relationships.getRelated(psetId, RelationshipType.DefinesByProperties, "forward")) push(onDemandPropertyMap, e, psetId);
  for (const qsetId of quantitySets) for (const e of relationships.getRelated(qsetId, RelationshipType.DefinesByProperties, "forward")) push(onDemandQuantityMap, e, qsetId);
  const materialRelIds = new Map();
  for (const [typeKey, ids] of entityIndex.byType) {
    if (!MATERIAL_DEF_TYPES.has(typeKey.toUpperCase())) continue;
    for (const materialId of ids) {
      for (const edge of relationships.forward.getEdges(materialId, RelationshipType.AssociatesMaterial)) {
        let list = onDemandMaterialMap.get(edge.target), relIds = materialRelIds.get(edge.target);
        if (!list || !relIds) { onDemandMaterialMap.set(edge.target, (list = [])); materialRelIds.set(edge.target, (relIds = [])); }
        let at = relIds.length;
        while (at > 0 && relIds[at - 1] > edge.relationshipId) at--;
        relIds.splice(at, 0, edge.relationshipId);
        list.splice(at, 0, materialId);
      }
    }
  }
  return { onDemandPropertyMap, onDemandQuantityMap, onDemandMaterialMap };
}

// utils/localParsingUtils.ts:229-249
function calculateStoreyHeights(storeyElevations) {
  const heights = new Map();
  if (storeyElevations.size < 2) return heights;
  const sorted = [...storeyElevations.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < sorted.length - 1; i++) { const h = sorted[i + 1][1] - sorted[i][1]; if (h > 0) heights.set(sorted[i][0], h); }
  return heights;
}

const cacheSchemaToVersion = (schema) => (schema === SchemaVersion.IFC4 ? "IFC4" : schema === SchemaVersion.IFC4X3 ? "IFC4X3" : "IFC2X3"); // useIfcCache.ts:84-90

/**
 * Ouvre une entrée : en-tête, modèle de données (sans géométrie), index d'entités, cartes à la demande, hiérarchie
 * spatiale ; la géométrie reste à lire morceau par morceau (open.readChunk). Source : celle du cache (palier
 * « source ») sinon le fichier fourni (palier mesh-only, fallbackSourceBuffer de leur loader).
 * @returns {Promise<{ dataStore, open, shards: ArrayBuffer[], hasGeometry: boolean, sourceFrom: "cache"|"fichier" }>}
 */
export async function openCachedEntry(cacheResult, fallbackSourceBuffer) {
  const reader = new BinaryCacheReader();
  const raw = cacheResult.buffer;
  const cacheBuffer = raw instanceof Blob ? await raw.arrayBuffer() : raw;
  const headerInfo = reader.readHeader(cacheBuffer);
  if (headerInfo.version < 13) throw new Error(`unexpected pre-v13 cache entry (v${headerInfo.version})`);
  const geometrySection = headerInfo.sections.find((s) => s.type === SectionType.Geometry);
  const result = await reader.read(cacheBuffer, { skipGeometry: true });
  const cacheStore = result.dataStore;
  const sourceBuffer = cacheResult.sourceBuffer ?? fallbackSourceBuffer;
  let source = new Uint8Array(0);
  let entityIndex = { byId: new Map(), byType: new Map() };
  let maps = {};
  if (sourceBuffer) {
    source = new Uint8Array(sourceBuffer);
    // Leur repli « cache v3 sans index d'entités » (rebalayage de la source) n'est pas porté : FORMAT_VERSION 23 l'écrit toujours.
    if (!result.entityIndex) throw new Error("cache entry without entity index (pre-v4 fallback not ported)");
    entityIndex = buildEntityIndexFromCachedColumns(result.entityIndex);
    maps = rebuildOnDemandMaps(cacheStore.entities, cacheStore.relationships, entityIndex);
  }
  const dataStore = attachDataStoreAccessors({
    schemaVersion: cacheSchemaToVersion(cacheStore.schema), entityCount: cacheStore.entityCount, fileSize: sourceBuffer?.byteLength ?? 0,
    parseTime: 0, source: asSourceBytes(source), strings: cacheStore.strings, entities: cacheStore.entities, properties: cacheStore.properties,
    quantities: cacheStore.quantities, relationships: cacheStore.relationships, entityIndex, spatialHierarchy: cacheStore.spatialHierarchy,
    onDemandPropertyMap: maps.onDemandPropertyMap, onDemandQuantityMap: maps.onDemandQuantityMap, onDemandMaterialMap: maps.onDemandMaterialMap,
  });
  // Hiérarchie spatiale reconstruite si le cache ne la porte pas (useIfcCache.ts:324-344).
  if (!dataStore.spatialHierarchy && dataStore.entities && dataStore.relationships) {
    if (dataStore.source && dataStore.source.length > 0 && dataStore.entityIndex && dataStore.strings) {
      const lengthUnitScale = extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
      dataStore.spatialHierarchy = new SpatialHierarchyBuilder().build(dataStore.entities, dataStore.relationships, dataStore.strings, dataStore.source, dataStore.entityIndex, lengthUnitScale);
      if (dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
        for (const [id, h] of calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations)) dataStore.spatialHierarchy.storeyHeights.set(id, h);
      }
    } else throw new Error("cache entry without source: spatial-hierarchy fallback not ported");
  }
  let open = null, shards = [];
  if (geometrySection && headerInfo.hasGeometry) {
    open = openGeometryChunksV13(cacheBuffer, geometrySection.offset, headerInfo.version);
    const shardsSection = headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
    if (shardsSection) { const r = new BufferReader(cacheBuffer); r.position = shardsSection.offset; shards = readInstancedShards(r); }
  }
  return { dataStore, open, shards, hasGeometry: !!open, sourceFrom: cacheResult.sourceBuffer ? "cache" : "fichier", cacheBytes: cacheBuffer.byteLength };
}
