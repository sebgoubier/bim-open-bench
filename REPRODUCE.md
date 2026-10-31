# Reproducing the October 2026 web BIM benchmark

This branch holds the harness I used for the Web BIM Benchmark 2026
(https://sebgoubier.github.io/scenoptic-benchmarks/2026-10/), built on top of Christopher Diggins'
bim-open-bench. It contains the measurement scripts and the panes of the viewers I compared
(xeokit, That Open, IFClite, BIM Open Viewer). The Scenoptic panes are not included: Scenoptic is not
open source. The two private structural models of the report (tests 2 and 3) are not included either.

`git diff origin/main...repro/oct-2026` shows every change made to the original repository.

## What I added to bim-open-bench

- `scripts/gpu-path-probe.mjs`: GPU time of every frame along a fixed 20 s camera path (601 poses at
  30 steps per second), through `EXT_disjoint_timer_query` (WebGL) or `timestamp-query` (WebGPU). The
  report uses the mean of all frames. It also samples the CPU of every Chrome process.
- `scripts/view.mjs`: cold and warm loading, RAM and GPU memory sampled during and after loading.
- `scripts/rebench.mjs` and `scripts/rebench-report.mjs`: run the whole matrix case by case and build
  the report (`scripts/lib/rebench-matrix.mjs` lists the cases).
- `tools/camera-path.mjs`, `tools/pane.mjs`: the shared camera path and pane contract, including
  assembly offsets (`offsets`, metres, Y-up world).
- `site/solo.html`, `scripts/spin-video.mjs`: one viewer at full size, and the video path
  (overview, descent, rotation at the centre of the model).

## xeokit as tested

- `@xeokit/xeokit-sdk` 2.6.114, `XKTLoaderPlugin` with its defaults (`tools/xeokit/pane.mjs`).
- Models converted with `@xeokit/xeokit-convert` 1.3.2 `convert2xkt`, default options
  (`tools/xeokit/to-xkt.mjs`, called by `scripts/converters/xkt.mjs`).
- `WebIFCLoaderPlugin` (web-ifc 0.0.51) is wired in the pane for raw IFC, but raw IFC was not measured
  for xeokit in the report.
- SAO and edges were not enabled: the effects test of the report did not cover xeokit.
- Fix made after publication: the assembly loader ignored the copies' offsets, so in tests 5 and 6
  (4 and 8 copies of the building) the copies were stacked in one place. The pane now passes
  `position` to `XKTLoaderPlugin.load` for each part (see the diff of `tools/xeokit/pane.mjs`).

## Test sets

Sixty5, from the buildingSMART Community Sample Test Files:
https://github.com/buildingsmart-community/Community-Sample-Test-Files/tree/main/IFC%202.3.0.1%20(IFC%202x3)/SDK%20-%20S1

| Report | Model id | Content |
|---|---|---|
| Test 1 | `sixty5` | architecture file alone, 343 MB |
| Test 4 | `sixty5-building` | the 7 discipline files, 842 MB |
| Test 5 | `sixty5-x4` | 4 copies of test 4 in a 2 × 2 grid (60 m × 80 m pitch) |
| Test 6 | `sixty5-x8` | 8 copies |
| Test 7 | `sixty5-x16` | 16 copies |

```sh
npm ci
node scripts/fetch.mjs                                   # the public models of the manifest
node scripts/add-sixty5-assembly.mjs <folder of the S1 IFC files>
node scripts/add-sixty5-matrix.mjs 60 80                 # sixty5-x2 … sixty5-x16
node scripts/tools.mjs xeokit                            # installs and builds the xeokit pane
node scripts/convert.mjs --form xkt
```

## Running the xeokit cases

```sh
# GPU time along the camera path (one case)
node scripts/gpu-path-probe.mjs --tool xeokit --model sixty5-x4 --form xkt --out results/xeokit-x4.json

# cold and warm loading
node scripts/view.mjs --tool xeokit --model sixty5-x4 --form xkt --repeat 2 --warm 2 --out results/open.json

# a whole series, xeokit only
node scripts/rebench.mjs --machine <name> --only xeokit
```

## Test conditions

- Chrome 156, one viewer per page and per Chrome profile, fixed canvas of about 1264 × 600 at device
  pixel ratio 1, no MSAA, no vsync during the GPU path.
- NVIDIA GPUs locked at a fixed clock (`nvidia-smi -lgc`, see `scripts/nv-clock-start.ps1`):
  without it, light WebGPU loads stay in low power states and read up to 10× slower.
- Each case has a 10-minute cap; a case still running after that counts as failed.
- GPUs of the report: RTX 4090 Laptop (2 340 MHz), Quadro T2000 Max-Q (1 575 MHz), Radeon 890M,
  Intel UHD Xe (gen 12), Intel UHD 630 (gen 9).

Comments in the scripts are in French; the commands and file names are what matter here.
