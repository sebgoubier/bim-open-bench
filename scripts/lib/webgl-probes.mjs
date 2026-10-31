// LOCAL ONLY (rebench tâche 5) : sondes WebGL injectées (Page.addScriptToEvaluateOnNewDocument), copie À L'IDENTIQUE
// des chaînes COUNTER et GPUTIMER de scripts/fair-probe.mjs (qui n'est pas modifié). Toute correction se fait aux deux endroits.
//   COUNTER  : self.__tri = { t: triangles, d: draws, md: multi-draws, l: lignes } cumulés depuis la dernière remise à zéro.
// Revue finale, important 8 : SEUL écart à fair-probe (qui n'est pas modifié) : COUNTER compte aussi les draws faits HORS
// callback rAF (self.__tri.raf = { draws, outside }, cumulés, remis à zéro par self.__tri.rafReset()) ; un viewer qui dessine
// hors rAF échappe au timer query de GPUTIMER (posé autour des callbacks rAF), gpu-path-probe le classe alors « non mesuré ».
//   GPUTIMER : self.__gpuT = { ctxs, pend, done, tag, frames(tag?), drain(tag), med(tag?) }, timer query autour de chaque callback rAF.
export const COUNTER = `(() => { const c = self.__tri = { t: 0, d: 0, md: 0, l: 0 };
  c.raf = { draws: 0, outside: 0 }; c.rafReset = () => { c.raf.draws = 0; c.raf.outside = 0; }; let inRaf = false;
  const rq = self.requestAnimationFrame; if (rq) self.requestAnimationFrame = function (cb) { return rq.call(this, (ts) => { const prev = inRaf; inRaf = true; try { return cb(ts); } finally { inRaf = prev; } }); };
  const seen = () => { c.raf.draws++; if (!inRaf) c.raf.outside++; };
  const P = self.WebGL2RenderingContext?.prototype; if (!P) return;
  const tri = (mode, n) => (mode === 4 ? n / 3 : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0);
  for (const [n, f] of [["drawElements", (a) => tri(a[0], a[1])], ["drawArrays", (a) => tri(a[0], a[2])], ["drawElementsInstanced", (a) => tri(a[0], a[1]) * a[4]], ["drawArraysInstanced", (a) => tri(a[0], a[2]) * a[3]], ["drawRangeElements", (a) => tri(a[0], a[3])]]) {
    const o = P[n]; P[n] = function (...a) { seen(); c.t += f(a); c.d++; if (a[0] >= 1 && a[0] <= 3) c.l += (n.includes("Arrays") ? a[2] : a[1]) * (n.includes("Instanced") ? (n.includes("Arrays") ? a[3] : a[4]) : 1) / (a[0] === 1 ? 2 : 1); return o.apply(this, a); }; }
  const ge = P.getExtension; P.getExtension = function (name) { const e = ge.call(this, name); if (e && /multi_draw/i.test(name) && !e.__fair) { e.__fair = 1;
    const wrap = (k, f) => { const o = e[k]; if (o) e[k] = function (...a) { seen(); c.t += f(a); c.d++; c.md++; return o.apply(this, a); }; };
    const sum = (arr, off, n, inst, ioff) => { let t = 0; for (let i = 0; i < n; i++) t += arr[off + i] * (inst ? inst[ioff + i] : 1); return t; };
    wrap("multiDrawElementsWEBGL", (a) => tri(a[0], sum(a[1], a[2], a[6])));
    wrap("multiDrawArraysWEBGL", (a) => tri(a[0], sum(a[3], a[4], a[5])));
    wrap("multiDrawElementsInstancedWEBGL", (a) => tri(a[0], sum(a[1], a[2], a[8], a[6], a[7])));
    wrap("multiDrawArraysInstancedWEBGL", (a) => tri(a[0], sum(a[3], a[4], a[7], a[5], a[6]))); } return e; }; })()`;
export const GPUTIMER = `(() => { const T = self.__gpuT = { ctxs: [], pend: [], done: [], tag: 0 };
  const gc = self.HTMLCanvasElement?.prototype.getContext; if (!gc) return;
  self.HTMLCanvasElement.prototype.getContext = function (type, ...a) { const g = gc.call(this, type, ...a);
    if (g && /webgl2/.test(type) && !T.ctxs.some((x) => x.g === g)) { const ext = g.getExtension("EXT_disjoint_timer_query_webgl2"); if (ext) T.ctxs.push({ g, ext }); } return g; };
  const raf = self.requestAnimationFrame.bind(self);
  self.requestAnimationFrame = (cb) => raf((ts) => { const qs = [];
    for (const c of T.ctxs) { try { const q = c.g.createQuery(); c.g.beginQuery(c.ext.TIME_ELAPSED_EXT, q); qs.push([c, q]); } catch {} }
    try { return cb(ts); } finally { for (const [c, q] of qs) { try { c.g.endQuery(c.ext.TIME_ELAPSED_EXT); T.pend.push({ c, q, ts, tag: T.tag }); } catch {} } } });
  const poll = () => { const keep = []; for (const e of T.pend) { const g = e.c.g; if (!g.getQueryParameter(e.q, g.QUERY_RESULT_AVAILABLE)) { keep.push(e); continue; }
      const dis = g.getParameter(e.c.ext.GPU_DISJOINT_EXT); const ns = g.getQueryParameter(e.q, g.QUERY_RESULT); g.deleteQuery(e.q); if (!dis) T.done.push([e.ts, e.tag, ns / 1e6]); }
    T.pend = keep; setTimeout(poll, 2); }; setTimeout(poll, 2);
  // Temps GPU par image (somme des callbacks d'une même image), images sans travail GPU exclues.
  T.frames = (tag) => { const m = new Map(); for (const [ts, tg, ms] of T.done) if (tag == null || tg === tag) m.set(ts, (m.get(ts) ?? 0) + ms); return [...m.values()].filter((x) => x > 0.02); };
  T.drain = async (tag) => { const t0 = performance.now(); while (T.pend.some((e) => e.tag === tag) && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20)); };
  T.med = (tag) => { const a = T.frames(tag).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(3) : null; };
})()`;
