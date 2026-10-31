// local (rebench) : bundle WebGPU du pane That Open (dist-webgpu/), chargé par tools/thatopen-webgpu et
// tools/thatopen-webgpu-fx. Même configuration que vite.config.mjs (pane.mjs, fichiers copiés dans la sortie),
// plus les trois alias de la section « WebGPU (opt-in) » du README de @thatopen/components-front 3.6 :
//   - three → three/webgpu (un seul graphe de modules : WebGPURenderer et les node materials sur le même three) ;
//   - les lignes épaisses de three (Line2, LineSegments2, LineMaterial, Wireframe) → webgpu/lines.mjs ;
//   - les passes EffectComposer (WebGL seulement) → webgpu/webgl-addons-stub.mjs (lève une erreur si un chemin
//     WebGL est construit sous WebGPU).
// Le pane lui-même passe { mode: "webgpu" } au PostproductionRenderer quand window.__TOC_MODE === "webgpu".
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.mjs";

export default mergeConfig(base, defineConfig({
  resolve: {
    alias: [
      { find: /^three$/, replacement: "three/webgpu" },
      {
        find: /^three\/(examples\/jsm|addons)\/lines\/(Line2|LineSegments2|LineMaterial|Wireframe)\.js$/,
        replacement: "@thatopen/components-front/webgpu/lines.mjs",
      },
      {
        find: /^three\/(examples\/jsm|addons)\/postprocessing\/.*$/,
        replacement: "@thatopen/components-front/webgpu/webgl-addons-stub.mjs",
      },
    ],
  },
  build: { outDir: "dist-webgpu" },
}));
