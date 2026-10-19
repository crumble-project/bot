import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { DEFAULT_CHART_HEIGHT, type ChartCompiler } from "./charts";

export const DISPLAY_TOOL_NAME = "show";

const label = Type.String({ minLength: 1, maxLength: 120 });
const title = Type.Optional(Type.String({ minLength: 1, maxLength: 200 }));

const stats = Type.Object({
  kind: Type.Literal("stats"),
  title,
  items: Type.Array(
    Type.Object({
      label,
      value: Type.String({ minLength: 1, maxLength: 40 }),
      change: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
      trend: Type.Optional(
        Type.Union([
          Type.Literal("up"),
          Type.Literal("down"),
          Type.Literal("flat"),
        ]),
      ),
      caption: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    { minItems: 1, maxItems: 6 },
  ),
});

const table = Type.Object({
  kind: Type.Literal("table"),
  title,
  columns: Type.Array(label, { minItems: 1, maxItems: 12 }),
  rows: Type.Array(
    Type.Array(Type.Union([Type.String({ maxLength: 500 }), Type.Number()]), {
      maxItems: 12,
    }),
    { minItems: 1, maxItems: 100 },
  ),
});

const chart = Type.Object({
  kind: Type.Literal("chart"),
  title,
  height: Type.Optional(Type.Integer({ minimum: 120, maximum: 480 })),
  code: Type.String({ minLength: 1, maxLength: 60000 }),
});

const component = Type.Union([stats, table, chart]);

type Component = Static<typeof component>;

/** Count rules the schema cannot express; the model gets the message back as a tool error and can retry. */
function countMismatch(value: Component): string | undefined {
  if (value.kind !== "table") return undefined;
  const width = value.columns.length;
  const row = value.rows.findIndex((cells) => cells.length !== width);

  if (row !== -1)
    return `Row ${row} has ${value.rows[row]!.length} cells; every row needs ${width}, one per column.`;

  return undefined;
}

const CHART_DOCS = join(
  dirname(fileURLToPath(import.meta.resolve("@tanstack/charts"))),
  "../docs",
);

/** Docs for the chart families the sandbox bundles; maps, spatial marks, and DOM interaction are left out. */
const UNBUNDLED =
  /^(examples\/(index|interactive-charts|maps-and-spatial|themes-and-motion)|marks\/(contour|delaunay|density|focus-guide|geo|hexbin|voronoi))$/;

const chartTopics = new Map<string, string>([
  ...["examples", "reference/marks"].flatMap((folder) =>
    readdirSync(join(CHART_DOCS, folder)).map((file): [string, string] => [
      `${basename(folder)}/${basename(file, ".md")}`,
      join(CHART_DOCS, folder, file),
    ]),
  ),
  ["guides/choosing-a-chart", join(CHART_DOCS, "guides/choosing-a-chart.md")],
]);

for (const topic of chartTopics.keys())
  if (UNBUNDLED.test(topic)) chartTopics.delete(topic);

/** Inline chat visuals. Clients render the validated component from the tool result's details. */
export function displayExtension(charts: ChartCompiler) {
  const show = defineTool({
    name: DISPLAY_TOOL_NAME,
    description: `Show the owner a visual inline in your reply. Use it when a visual reads faster than prose, not for one or two plain facts. Your turn ends once it is shown, so call it last and write any text before the call. Do not restate the shown data in that text; add only interpretation the visual lacks, or nothing.
- "stats": one to six headline numbers. Give values formatted for display (e.g. "€1.2M", "+4.3%").
- "table": rows to compare.
- "chart": TanStack Charts code, TypeScript allowed, the same module form as its docs: import from "@tanstack/charts", "@tanstack/charts/polar", "@tanstack/charts/hierarchy/treemap", "@tanstack/charts/hierarchy/sunburst", "@tanstack/charts/network/sankey", "@tanstack/charts/scales/{linear,band,point,ordinal}", or "d3-scale" (scaleUtc, scaleTime, scaleLog, scaleSqrt), and "export default defineChart({...})". Nothing else is importable and there is no I/O: put the data inline. Omit colors and sizes so the chart follows the app theme; set a tooltip "format" for non-Cartesian charts. Example:
import { barY, defineChart } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
const rows = [{ id: "de", country: "Germany", people: 84 }, { id: "fr", country: "France", people: 68 }]
export default defineChart({ marks: [barY(rows, { x: "country", y: "people" })], scales: { x: { scale: () => scaleBand<string>().padding(0.2) }, y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Population (M)" } } } })
Sankey links are straight unless you pass a curve. Bend them with a bump curve, keep them translucent, and label nodes beside their bars:
const bumpX = { line: ([[x0, y0], [x1, y1]]) => "M" + x0 + "," + y0 + "C" + (x0 + x1) / 2 + "," + y0 + " " + (x0 + x1) / 2 + "," + y1 + " " + x1 + "," + y1, area: () => "" }
link(layoutLinks, { x1: "x1", y1: "y1", x2: "x2", y2: "y2", key: "key", curve: bumpX, strokeWidth: (flow) => Math.max(1, flow.width), strokeOpacity: 0.4, lineCap: "butt" }) and text(layoutNodes, { x: "x1", y: "y", dx: 6, anchor: "start", ... }).
Read chart_docs before using a mark or chart family you are unsure of.`,
    parameters: Type.Object({ component }),
    // Scripts cannot render to the owner, so code mode keeps this as a direct model tool.
    callers: ["model"],
    replay: "safe",
    execute: async ({ component }, _api, context) => {
      const error = countMismatch(component);

      if (error) throw new Error(error);
      context.abortSignal?.throwIfAborted();

      if (component.kind !== "chart")
        return {
          output: [{ type: "text" as const, text: "Shown to the owner." }],
          details: component,
          control: { terminate: true as const },
        };

      // Clients receive the compiled layouts, never the code.
      const { code, height, ...chart } = component;

      const details = {
        ...chart,
        layouts: await charts.compile(code, height ?? DEFAULT_CHART_HEIGHT),
      };

      return {
        output: [{ type: "text" as const, text: "Shown to the owner." }],
        details,
        control: { terminate: true as const },
      };
    },
  });

  const docs = defineTool({
    name: "chart_docs",
    description: `Read TanStack Charts documentation for the show tool's "chart" code: runnable examples and mark references. Topics: ${[...chartTopics.keys()].join(", ")}.`,
    parameters: Type.Object({
      topic: Type.Union(
        [...chartTopics.keys()].map((topic) => Type.Literal(topic)),
      ),
    }),
    replay: "safe",
    execute: async ({ topic }) => ({
      output: [
        {
          type: "text" as const,
          text: await Bun.file(chartTopics.get(topic)!).text(),
        },
      ],
    }),
  });

  return defineExtension({ name: "display", tools: [show, docs] });
}
