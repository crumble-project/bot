import { z } from "zod";
import { CHART_SERIES_COLORS } from "../shared/limits";

const MAX_PRIMITIVES = 6000;

const COLOR = new RegExp(
  `^(none|foreground|background|series-[1-${CHART_SERIES_COLORS}]|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$`,
);

const RGB =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/;

const hexByte = (channel: number) =>
  Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");

export function chartColor(value: string): string {
  const trimmed = value.trim();
  const variable = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(trimmed);

  if (variable?.[1]) {
    return chartColor(variable[1]);
  }

  if (trimmed === "transparent") {
    return "none";
  }

  if (trimmed === "currentColor") {
    return "foreground";
  }

  if (trimmed === "Canvas") {
    return "background";
  }
  const rgb = RGB.exec(trimmed);

  if (!rgb) {
    return trimmed;
  }

  const alpha = rgb[4]?.endsWith("%")
    ? Number.parseFloat(rgb[4]) / 100
    : Number(rgb[4] ?? 1);

  const channels = [rgb[1], rgb[2], rgb[3]].map(Number);

  return `#${[...channels, ...(alpha < 1 ? [alpha * 255] : [])].map(hexByte).join("")}`;
}

const validatedColor = z
  .string()
  .regex(
    COLOR,
    "Use hex colors such as #2a78d6, or omit colors to use the theme.",
  );

const color = z.string().transform(chartColor).pipe(validatedColor);

const finite = z.number();

const lineJoin = z.enum(["miter", "round", "bevel"]);

const paintFields = (
  colorSchema: z.ZodType<string>,
  joinSchema: z.ZodType<"miter" | "round" | "bevel">,
) => ({
  fill: colorSchema.optional(),
  fillOpacity: finite.optional(),
  stroke: colorSchema.optional(),
  strokeOpacity: finite.optional(),
  strokeWidth: finite.optional(),
  opacity: finite.optional(),
  lineCap: z.enum(["butt", "round", "square"]).optional(),
  lineJoin: joinSchema.optional(),
  dash: z.array(finite).max(16).optional(),
  clip: z.tuple([finite, finite, finite, finite]).optional(),
});

const command = z.union([
  z.tuple([z.literal("M"), finite, finite]),
  z.tuple([z.literal("L"), finite, finite]),
  z.tuple([z.literal("Q"), finite, finite, finite, finite]),
  z.tuple([z.literal("C"), finite, finite, finite, finite, finite, finite]),
  z.tuple([z.literal("Z")]),
]);

const primitiveOf = (paint: ReturnType<typeof paintFields>) =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("line"),
      x1: finite,
      y1: finite,
      x2: finite,
      y2: finite,
      ...paint,
    }),
    z.object({
      kind: z.literal("path"),
      commands: z.array(command),
      evenOdd: z.boolean().optional(),
      ...paint,
    }),
    z.object({
      kind: z.literal("circle"),
      x: finite,
      y: finite,
      radius: finite,
      ...paint,
    }),
    z.object({
      kind: z.literal("rect"),
      x: finite,
      y: finite,
      width: finite,
      height: finite,
      radius: finite,
      ...paint,
    }),
    z.object({
      kind: z.literal("text"),
      x: finite,
      y: finite,
      text: z.string().max(500),
      anchor: z.enum(["start", "middle", "end"]),
      baseline: z.enum(["auto", "middle", "hanging"]),
      rotate: finite,
      size: finite,
      weight: finite,
      ...paint,
    }),
  ]);

const primitive = primitiveOf(
  paintFields(
    color,
    z
      .string()
      .transform((join): "miter" | "round" | "bevel" =>
        join === "round" || join === "bevel" ? join : "miter",
      ),
  ),
);

const parsedPrimitive = primitiveOf(paintFields(validatedColor, lineJoin));

const label = z.string().max(500);

const tooltipRow = (colorSchema: z.ZodType<string>) =>
  z.object({ label, value: label, color: colorSchema.optional() });

const tooltip = z.union([
  z
    .string()
    .max(1000)
    .transform((text) => ({ text, rows: [] })),
  z.object({
    title: label.optional(),
    color: color.optional(),
    rows: z.array(tooltipRow(color)).max(50),
  }),
]);

const point = z
  .object({ x: finite, y: finite, color: color.optional(), tooltip })
  .transform(({ tooltip, ...anchor }) => ({ ...anchor, ...tooltip }));

const parsedPoint = z.union([
  z.object({
    x: finite,
    y: finite,
    color: validatedColor.optional(),
    text: z.string().max(1000),
    rows: z.array(z.never()).max(0),
  }),
  z.object({
    x: finite,
    y: finite,
    color: validatedColor.optional(),
    title: label.optional(),
    rows: z.array(tooltipRow(validatedColor)).max(50),
  }),
]);

export const chartLayout = z.object({
  width: finite,
  height: finite,
  nodes: z.array(primitive).max(MAX_PRIMITIVES),
  points: z.array(point).max(MAX_PRIMITIVES),
});

export const parsedChartLayout = z.object({
  width: finite,
  height: finite,
  nodes: z.array(parsedPrimitive).max(MAX_PRIMITIVES),
  points: z.array(parsedPoint).max(MAX_PRIMITIVES),
});

export type ChartLayoutInput = z.input<typeof chartLayout>;

export type ChartLayout = z.infer<typeof chartLayout>;
