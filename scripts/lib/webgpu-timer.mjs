// LOCAL ONLY (rebench tâche 4) : crochet générique de temps GPU WebGPU, pour n'importe quel viewer.
// Même esprit que GPUTIMER de fair-probe.mjs (WebGL) : injecté par Page.addScriptToEvaluateOnNewDocument, il expose
// self.__gpuW = { devices, frames(tag?), med(tag?), drain(tag), tag, quantized, lost }.
// Principe : timestampWrites posés sur chaque passe (render et compute) qui n'en a pas déjà ; les passes déjà horodatées
// par le viewer sont relues dans SON querySet (resolveQuerySet n'altère rien) quand elles ont début ET fin. Temps GPU
// d'une image = union des intervalles de ses passes. Image = images d'animation (rAF) numérotées.
// Angles morts connus : copies et resolve hors passe, passes encodées dans un worker, passes horodatées par le viewer
// avec un seul des deux index.

/**
 * Durée GPU par image (ms) : union des intervalles [beginNs, endNs] des passes d'une même image (les chevauchements ne
 * comptent qu'une fois), images triées par numéro, images < 0,02 ms exclues. `tag` filtre les passes.
 * Autonome (aucune référence extérieure) : sérialisée telle quelle dans la source injectée.
 */
export function framesFromSpans(spans, tag) {
  const byFrame = new Map();
  for (const s of spans) {
    if (tag != null && s.tag !== tag) continue;
    if (!(s.endNs > s.beginNs)) continue;
    let a = byFrame.get(s.frame);
    if (!a) byFrame.set(s.frame, (a = []));
    a.push(s);
  }
  const out = [];
  for (const f of [...byFrame.keys()].sort((x, y) => x - y)) {
    const a = byFrame.get(f).slice().sort((x, y) => (x.beginNs < y.beginNs ? -1 : x.beginNs > y.beginNs ? 1 : 0));
    let total = 0n, curB = a[0].beginNs, curE = a[0].endNs;
    for (let i = 1; i < a.length; i++) {
      if (a[i].beginNs <= curE) { if (a[i].endNs > curE) curE = a[i].endNs; }
      else { total += curE - curB; curB = a[i].beginNs; curE = a[i].endNs; }
    }
    total += curE - curB;
    const ms = Number(total) / 1e6;
    if (ms >= 0.02) out.push(ms);
  }
  return out;
}

// local (rebench) : tâche 5 — durées par image AVEC leur numéro d'image (gpu-path-probe : une image par pas de caméra).
/** Comme framesFromSpans, mais [{ frame, ms }] (numéro d'image de __gpuW) ; autonome, sérialisée dans la source injectée. */ // local (rebench)
export function frameDurationsFromSpans(spans, tag) { // local (rebench)
  const byFrame = new Map(); // local (rebench)
  for (const s of spans) { if (tag != null && s.tag !== tag) continue; if (!(s.endNs > s.beginNs)) continue; let a = byFrame.get(s.frame); if (!a) byFrame.set(s.frame, (a = [])); a.push(s); } // local (rebench)
  const out = []; // local (rebench)
  for (const f of [...byFrame.keys()].sort((x, y) => x - y)) { // local (rebench)
    const a = byFrame.get(f).slice().sort((x, y) => (x.beginNs < y.beginNs ? -1 : x.beginNs > y.beginNs ? 1 : 0)); // local (rebench)
    let total = 0n, curB = a[0].beginNs, curE = a[0].endNs; // local (rebench)
    for (let i = 1; i < a.length; i++) { if (a[i].beginNs <= curE) { if (a[i].endNs > curE) curE = a[i].endNs; } else { total += curE - curB; curB = a[i].beginNs; curE = a[i].endNs; } } // local (rebench)
    total += curE - curB; // local (rebench)
    const ms = Number(total) / 1e6; // local (rebench)
    if (ms >= 0.02) out.push({ frame: f, ms }); // local (rebench)
  } // local (rebench)
  return out; // local (rebench)
} // local (rebench)

// local (rebench) : tâche 5 — passes horodatées par le viewer avec UN seul index (étape en plusieurs passes : début
// local (rebench) : écrit par la première, fin par la dernière). Une passe « début seul » (b) s'apparie à la première
// local (rebench) : passe « fin seule » suivante du même querySet d'index b + 1 : l'intervalle couvre toute l'étape.
/** recs : enregistrements d'un submit, dans l'ordre ; partial = true pour un index seul (b ou e à null). Renvoie { recs, paired, unpaired }. */ // local (rebench)
export function pairPartialRecs(recs) { // local (rebench)
  const out = [], used = new Set(); let paired = 0, unpaired = 0; // local (rebench)
  for (let i = 0; i < recs.length; i++) { const r = recs[i]; // local (rebench)
    if (!r.partial) { out.push(r); continue; } // local (rebench)
    if (used.has(i)) continue; // local (rebench)
    if (r.b == null) { unpaired++; continue; } // fin sans début ouvert // local (rebench)
    let j = -1; for (let k = i + 1; k < recs.length; k++) { const x = recs[k]; if (x.partial && !used.has(k) && x.b == null && x.qs === r.qs && x.e === r.b + 1) { j = k; break; } } // local (rebench)
    if (j < 0) { unpaired++; continue; } // local (rebench)
    used.add(j); paired++; // local (rebench)
    out.push({ qs: r.qs, b: r.b, e: recs[j].e, frame: r.frame, tag: r.tag, label: (r.label || "?") + ".." + (recs[j].label || "?"), foreign: true }); // local (rebench)
  } // local (rebench)
  return { recs: out, paired, unpaired }; // local (rebench)
} // local (rebench)

/** Vrai si toutes les durées non nulles sont des multiples de 65 536 ns (horodatages quantifiés) ; liste sans durée non nulle ⟹ faux. */
export function isQuantized(durationsNs) {
  const v = durationsNs.filter((d) => d !== 0n);
  return v.length > 0 && v.every((d) => d % 65536n === 0n);
}

export const WEBGPU_TIMER_SOURCE = `(() => { if (!self.GPUAdapter || self.__gpuW) return;
  ${framesFromSpans.toString()}
  ${isQuantized.toString()}
  ${frameDurationsFromSpans.toString()} // local (rebench)
  ${pairPartialRecs.toString()} // local (rebench)
  const RING = 2048; // passes en vol par device (2 requêtes chacune)
  const MAX_SPANS = 400000;
  const spans = [];
  const pendByTag = new Map();
  const W = self.__gpuW = { devices: [], tag: 0, lost: null, spans, counts: { own: 0, foreign: 0, foreignPartial: 0, readbacks: 0, readFail: 0, passes: 0, outsideRaf: 0, ownSubmitFail: 0, foreignPaired: 0, foreignUnpaired: 0 }, /* local (rebench) : foreignPaired/Unpaired */
    // Plus de 5 % des passes encodées hors callback rAF : le découpage en images n'a plus de sens ⟹ « non mesuré ».
    get unreliable() { return W.counts.passes > 0 && W.counts.outsideRaf / W.counts.passes > 0.05; },
    frames: (tag) => framesFromSpans(spans, tag),
    framesById: (tag) => frameDurationsFromSpans(spans, tag), // local (rebench)
    // local (rebench) : revue finale, important 4 : reset() vide les spans (et les compteurs passes / outsideRaf qui jugent
    // local (rebench) : unreliable), appelé par le pilote de gpu-path-probe après « done » : un long chargement ne peut
    // local (rebench) : plus saturer MAX_SPANS avant la mesure, et unreliable ne juge que la fenêtre mesurée.
    reset: () => { spans.length = 0; W.counts.passes = 0; W.counts.outsideRaf = 0; }, // local (rebench)
    med: (tag) => { if (W.unreliable) return null; const a = framesFromSpans(spans, tag).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(3) : null; },
    drain: async (tag) => { const t0 = performance.now(); while ((pendByTag.get(tag) ?? 0) > 0 && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20)); },
    // Durées par étiquette de passe (diagnostic).
    byLabel: (tag) => { const m = {}; for (const s of spans) if (tag == null || s.tag === tag) { const k = (s.foreign ? "*" : "") + (s.label || "?"); (m[k] ??= []).push(Number(s.endNs - s.beginNs) / 1e6); } const r = {}; for (const [k, a] of Object.entries(m)) { a.sort((x, y) => x - y); r[k] = { n: a.length, med: +a[a.length >> 1].toFixed(4) }; } return r; },
    framesFromSpans, // exposée pour les diagnostics (sous-ensemble de passes)
    get quantized() { return isQuantized(spans.filter((s) => !s.foreign).map((s) => s.endNs - s.beginNs)); } };
  // Numéro d'image : incrémenté au premier callback rAF de chaque image d'animation (horodatage rAF nouveau).
  // inRaf : vrai pendant un callback rAF seulement ; une passe encodée hors rAF (événement, setTimeout, ResizeObserver)
  // tombe dans l'image courante, d'où le compteur outsideRaf et l'indicateur unreliable.
  let frame = 0, lastTs = -1, inRaf = false;
  const raf = self.requestAnimationFrame;
  if (raf) self.requestAnimationFrame = function (cb) { return raf.call(this, (ts) => { if (ts !== lastTs) { lastTs = ts; frame++; } const prev = inRaf; inRaf = true; try { return cb(ts); } finally { inRaf = prev; } }); };
  W.frame = () => frame;
  const devState = new Map(); // device -> état
  const queueDev = new WeakMap(), encDev = new WeakMap(), encRecs = new WeakMap(), cbRecs = new WeakMap();
  const setup = (device) => { if (devState.has(device)) return devState.get(device);
    const st = { device, ts: device.features.has("timestamp-query"), next: 0, pool: new Map() };
    if (st.ts) st.qs = device.createQuerySet({ label: "bench.gpuW", type: "timestamp", count: 2 * RING });
    devState.set(device, st); queueDev.set(device.queue, device); W.devices.push({ ts: st.ts, adapter: device.adapterInfo ? device.adapterInfo.vendor + "/" + device.adapterInfo.architecture + "/" + device.adapterInfo.description : null });
    device.lost.then((i) => { W.lost = (i.reason ?? "") + " " + (i.message ?? ""); });
    return st; };
  const A = self.GPUAdapter.prototype, rd = A.requestDevice;
  A.requestDevice = async function (desc) { const d = { ...(desc ?? {}) };
    if (this.features.has("timestamp-query")) { const f = [...(d.requiredFeatures ?? [])]; if (!f.includes("timestamp-query")) f.push("timestamp-query"); d.requiredFeatures = f; }
    const device = await rd.call(this, d); setup(device); return device; };
  const D = self.GPUDevice.prototype, cce = D.createCommandEncoder;
  D.createCommandEncoder = function (...a) { const e = cce.apply(this, a); encDev.set(e, this); return e; };
  const E = self.GPUCommandEncoder.prototype;
  for (const name of ["beginRenderPass", "beginComputePass"]) { const orig = E[name];
    E[name] = function (desc) { const dev = encDev.get(this); const st = dev && devState.get(dev);
      if (!st || !st.ts || spans.length >= MAX_SPANS) return orig.call(this, desc);
      W.counts.passes++; if (!inRaf) W.counts.outsideRaf++;
      let recs = encRecs.get(this); if (!recs) encRecs.set(this, (recs = []));
      const tw = desc && desc.timestampWrites;
      if (tw) { // déjà horodatée par le viewer : on ne touche pas au descripteur, on relira ses requêtes
        if (tw.beginningOfPassWriteIndex != null && tw.endOfPassWriteIndex != null) recs.push({ qs: tw.querySet, b: tw.beginningOfPassWriteIndex, e: tw.endOfPassWriteIndex, frame, tag: W.tag, label: desc.label, foreign: true });
        else { W.counts.foreignPartial++; recs.push({ qs: tw.querySet, b: tw.beginningOfPassWriteIndex ?? null, e: tw.endOfPassWriteIndex ?? null, frame, tag: W.tag, label: desc.label, foreign: true, partial: true }); } // local (rebench)
        return orig.call(this, desc); }
      const s = st.next; st.next = (st.next + 1) % RING;
      recs.push({ qs: st.qs, b: 2 * s, e: 2 * s + 1, frame, tag: W.tag, label: desc && desc.label, foreign: false });
      return orig.call(this, { ...(desc ?? {}), timestampWrites: { querySet: st.qs, beginningOfPassWriteIndex: 2 * s, endOfPassWriteIndex: 2 * s + 1 } }); }; }
  const fin = E.finish;
  E.finish = function (...a) { const cb = fin.apply(this, a); const r = encRecs.get(this); if (r && r.length) cbRecs.set(cb, r); return cb; };
  const Q = self.GPUQueue.prototype, sub = Q.submit;
  Q.submit = function (cbs) { const list = [...cbs]; const dev = queueDev.get(this); const st = dev && devState.get(dev);
    const raw = st ? list.flatMap((cb) => cbRecs.get(cb) ?? []) : []; // local (rebench)
    const pr = pairPartialRecs(raw); W.counts.foreignPaired += pr.paired; W.counts.foreignUnpaired += pr.unpaired; const recs = pr.recs; // local (rebench)
    // La soumission du viewer part TELLE QUELLE ; la nôtre suit dans un submit séparé (ordre de file garanti) : un buffer
    // invalide de notre côté (querySet du viewer détruit, par exemple) ne peut plus faire rejeter l'image du viewer.
    const ret = sub.call(this, Array.isArray(cbs) ? cbs : list);
    if (!recs.length) return ret;
    // Une paire début/fin par passe à un décalage aligné sur 256 octets (deux blocs si les index ne se suivent pas).
    const offs = []; let blocks = 0; for (const r of recs) { offs.push(blocks); blocks += r.e === r.b + 1 ? 1 : 2; }
    const size = 256 * blocks; const U = self.GPUBufferUsage;
    const take = () => { const p = st.pool.get(size); return p && p.length ? p.pop() : { res: dev.createBuffer({ label: "bench.gpuW.resolve", size, usage: U.QUERY_RESOLVE | U.COPY_SRC }), map: dev.createBuffer({ label: "bench.gpuW.read", size, usage: U.MAP_READ | U.COPY_DST }) }; };
    // Notre encodage et notre submit sous une portée d'erreur de validation : échec compté (ownSubmitFail), jamais propagé.
    dev.pushErrorScope("validation"); let bufs;
    try { bufs = take(); const enc = cce.call(dev, { label: "bench.gpuW.resolve" });
      recs.forEach((r, i) => { const o = 256 * offs[i]; if (r.e === r.b + 1) enc.resolveQuerySet(r.qs, r.b, 2, bufs.res, o); else { enc.resolveQuerySet(r.qs, r.b, 1, bufs.res, o); enc.resolveQuerySet(r.qs, r.e, 1, bufs.res, o + 256); } });
      enc.copyBufferToBuffer(bufs.res, 0, bufs.map, 0, size); sub.call(this, [fin.call(enc)]);
    } catch { bufs = null; }
    for (const r of recs) pendByTag.set(r.tag, (pendByTag.get(r.tag) ?? 0) + 1);
    const done = () => { for (const r of recs) pendByTag.set(r.tag, pendByTag.get(r.tag) - 1); };
    // Relecture seulement si notre soumission est valide : sinon la copie n'a pas eu lieu et le tampon (recyclé) serait périmé.
    dev.popErrorScope().then((err) => { if (err || !bufs) { W.counts.ownSubmitFail++; done(); return; }
      return bufs.map.mapAsync(self.GPUMapMode.READ).then(() => { const t = new BigUint64Array(bufs.map.getMappedRange()); W.counts.readbacks++;
        recs.forEach((r, i) => { const k = 32 * offs[i], b = t[k], e = r.e === r.b + 1 ? t[k + 1] : t[k + 32]; if (e > b && b > 0n) { spans.push({ frame: r.frame, tag: r.tag, beginNs: b, endNs: e, label: r.label, foreign: r.foreign }); W.counts[r.foreign ? "foreign" : "own"]++; } });
        bufs.map.unmap(); (st.pool.get(size) ?? st.pool.set(size, []).get(size)).push(bufs); done(); }, () => { W.counts.readFail++; done(); }); }, () => { W.counts.ownSubmitFail++; done(); });
    return ret; };
})()`;
