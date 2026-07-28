import { writeFileSync } from "node:fs";
import { describe, it } from "vite-plus/test";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";

const DIR =
  "/private/tmp/claude-501/-Users-ericjohnson-GitHub-FactorioMapWebUI/18f5cb1c-429a-4224-8c23-f8b7c6fbc0d4/scratchpad";

interface Arm {
  label: string;
  fn: () => void;
  samples: number[];
}

describe("TEMP fused perf", () => {
  it("min-of-7 interleaved, fused vs sequential", () => {
    const V = 512;
    const base = {
      id: 0,
      seed0: 123456,
      width: V,
      height: V,
      originX: 0,
      originY: 0,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      mapType: "nauvis" as const,
      planet: "vulcanus" as const,
    };
    const arms: Arm[] = [
      { label: "terrain", fn: () => runRenderRequest({ ...base, view: "terrain" }), samples: [] },
      {
        label: "resources seq",
        fn: () => runRenderRequest({ ...base, view: "resources" }),
        samples: [],
      },
      {
        label: "resources FUSED",
        fn: () => runRenderRequest({ ...base, view: "resources", fusedPrototype: true }),
        samples: [],
      },
      { label: "all seq", fn: () => runRenderRequest({ ...base, view: "all" }), samples: [] },
      {
        label: "all FUSED",
        fn: () => runRenderRequest({ ...base, view: "all", fusedPrototype: true }),
        samples: [],
      },
    ];
    for (const a of arms) a.fn();
    for (let i = 0; i < 7; i++)
      for (const a of arms) {
        const t0 = performance.now();
        a.fn();
        a.samples.push(performance.now() - t0);
      }
    const min = (a: Arm): number => Math.min(...a.samples);
    const out = arms.map(
      (a) =>
        `${a.label.padEnd(18)} ${min(a).toFixed(0).padStart(6)} ms  (spread ${(Math.max(...a.samples) / min(a)).toFixed(2)}x)`,
    );
    const t = min(arms[0]);
    out.push("");
    out.push(`resources marginal seq   ${(min(arms[1]) - t).toFixed(0).padStart(6)} ms`);
    out.push(`resources marginal FUSED ${(min(arms[2]) - t).toFixed(0).padStart(6)} ms`);
    out.push(`ratio all/terrain seq    ${(min(arms[3]) / t).toFixed(3).padStart(6)}`);
    out.push(`ratio all/terrain FUSED  ${(min(arms[4]) / t).toFixed(3).padStart(6)}`);
    out.push(
      `all speedup              ${(((min(arms[3]) - min(arms[4])) / min(arms[3])) * 100).toFixed(1)}%`,
    );
    writeFileSync(`${DIR}/fusedperf.txt`, out.join("\n"));
  }, 1_800_000);
});
