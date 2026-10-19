import { Type, type Static } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

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
  chart: Type.Union([Type.Literal("bar"), Type.Literal("line")]),
  unit: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  labels: Type.Array(label, { minItems: 1, maxItems: 60 }),
  series: Type.Array(
    Type.Object({
      name: label,
      values: Type.Array(Type.Number(), { minItems: 1, maxItems: 60 }),
    }),
    { minItems: 1, maxItems: 6 },
  ),
});

const component = Type.Union([stats, table, chart]);

export type DisplayComponent = Static<typeof component>;

/** Count rules the schema cannot express; the model gets the message back as a tool error and can retry. */
function countMismatch(value: DisplayComponent): string | undefined {
  if (value.kind === "table") {
    const width = value.columns.length;
    const row = value.rows.findIndex((cells) => cells.length !== width);

    if (row !== -1)
      return `Row ${row} has ${value.rows[row]!.length} cells; every row needs ${width}, one per column.`;
  }

  if (value.kind === "chart") {
    const count = value.labels.length;
    const series = value.series.find((item) => item.values.length !== count);

    if (series)
      return `Series "${series.name}" has ${series.values.length} values; it needs ${count}, one per label.`;
  }

  return undefined;
}

/** Inline chat visuals. Clients render the validated component from the tool result's details. */
export function displayExtension() {
  const show = defineTool({
    name: DISPLAY_TOOL_NAME,
    description:
      'Show the owner a visual inline in your reply: "stats" for one to six headline numbers, "table" for rows to compare, or "chart" (bar or line) for values across labels such as dates or categories. Use it when a visual reads faster than prose, not for one or two plain facts. Give values already formatted for display (e.g. "€1.2M", "+4.3%"). Do not restate the shown data in your text; add only interpretation the visual lacks.',
    parameters: Type.Object({ component }),
    // Scripts cannot render to the owner, so code mode keeps this as a direct model tool.
    callers: ["model"],
    replay: "safe",
    execute: async ({ component }) => {
      const error = countMismatch(component);

      if (error) throw new Error(error);

      return {
        output: [{ type: "text" as const, text: "Shown to the owner." }],
        details: component,
      };
    },
  });

  return defineExtension({ name: "display", tools: [show] });
}
