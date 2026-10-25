import { afterAll, describe, expect, test } from "bun:test";
import { CHART_WIDTHS, ChartCompiler, chartColor } from "./charts";

const compiler = new ChartCompiler();

afterAll(() => compiler.close());

// The module form the TanStack docs use, so a library upgrade that breaks it fails here first.
const bars = `
import { barY, defineChart } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"

interface Row { id: string; country: string; people: number }
const rows: readonly Row[] = [
  { id: "de", country: "Germany", people: 84 },
  { id: "fr", country: "France", people: 68 },
]

export default defineChart({
  marks: [barY(rows, { x: "country", y: "people" })],
  scales: {
    x: { scale: () => scaleBand<string>().padding(0.2) },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Population (M)" } },
  },
})
`;

describe("ChartCompiler", () => {
  test("compiles documented TypeScript into themed layouts at every width", async () => {
    const layouts = await compiler.compile(bars, 200);

    expect(layouts.map((layout) => layout.width)).toEqual(CHART_WIDTHS);

    for (const layout of layouts) {
      expect(layout.height).toBe(200);
      const bars = layout.nodes.filter((node) => node.kind === "rect");

      expect(bars).toHaveLength(2);
      expect(bars.every((bar) => bar.fill === "series-1")).toBe(true);
      expect(
        layout.nodes.some(
          (node) => node.kind === "text" && node.text === "France",
        ),
      ).toBe(true);
      expect(layout.points.map((point) => point.rows)).toContainEqual([
        { label: "x", value: "Germany" },
        { label: "Population (M)", value: "84" },
      ]);
    }
  });

  test("rejects imports outside the bundled packages before running code", async () => {
    await expect(
      compiler.compile(
        `import { readFileSync } from "node:fs"\nexport default readFileSync("x")`,
      ),
    ).rejects.toThrow('Cannot import "node:fs"');
  });

  test("names unbundled exports", async () => {
    await expect(
      compiler.compile(
        `import { geoPath } from "@tanstack/charts/geo"\nexport default geoPath()`,
      ),
    ).rejects.toThrow("geoPath not available");
  });

  test("returns library errors to the model", async () => {
    await expect(
      compiler.compile(
        `import { barY, defineChart } from "@tanstack/charts"\nexport default defineChart({ marks: [barY([{ a: 1 }], { x: "a", y: "a" })], scales: {} })`,
      ),
    ).rejects.toThrow("Chart scales must define reserved `x` and `y` entries");
  });
});

describe("chartColor", () => {
  test("resolves CSS color syntax to theme tokens and hex", () => {
    expect(chartColor("var(--ts-chart-1, series-1)")).toBe("series-1");
    expect(chartColor("currentColor")).toBe("foreground");
    expect(chartColor("var(--ts-chart-focus-fill, Canvas)")).toBe("background");
    expect(chartColor("rgb(42, 120, 214)")).toBe("#2a78d6");
    expect(chartColor("rgba(42, 120, 214, 0.5)")).toBe("#2a78d680");
  });
});
