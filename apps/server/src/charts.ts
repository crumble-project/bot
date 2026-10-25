import { fileURLToPath } from "node:url";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { z } from "zod";

/** Layout widths that fit inside client cards unscaled: a phone column and the desktop reply. */
export const CHART_WIDTHS = [320, 520];
export const DEFAULT_CHART_HEIGHT = 240;
const MAX_PRIMITIVES = 6000;
const MAX_BYTES = 600_000;

const COLOR =
  /^(none|foreground|background|series-[1-8]|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$/;

const RGB =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/;

const hexByte = (channel: number) =>
  Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");

/**
 * Resolves the CSS color syntax TanStack emits (`var(--x, fallback)`, `currentColor`, `Canvas`, `rgb()`) to a theme
 * token clients resolve per appearance, or a hex literal.
 */
export function chartColor(value: string): string {
  const trimmed = value.trim();
  const variable = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(trimmed);

  if (variable?.[1]) return chartColor(variable[1]);

  if (trimmed === "transparent") return "none";

  if (trimmed === "currentColor") return "foreground";

  if (trimmed === "Canvas") return "background";
  const rgb = RGB.exec(trimmed);

  if (!rgb) return trimmed;

  const alpha = rgb[4]?.endsWith("%")
    ? Number.parseFloat(rgb[4]) / 100
    : Number(rgb[4] ?? 1);

  const channels = [rgb[1], rgb[2], rgb[3]].map(Number);

  return `#${[...channels, ...(alpha < 1 ? [alpha * 255] : [])].map(hexByte).join("")}`;
}

const color = z
  .string()
  .transform(chartColor)
  .pipe(
    z
      .string()
      .regex(
        COLOR,
        "Use hex colors such as #2a78d6, or omit colors to use the theme.",
      ),
  );

const finite = z.number().finite();

const paint = {
  fill: color.optional(),
  fillOpacity: finite.optional(),
  stroke: color.optional(),
  strokeOpacity: finite.optional(),
  strokeWidth: finite.optional(),
  opacity: finite.optional(),
  lineCap: z.enum(["butt", "round", "square"]).optional(),
  // Canvas-style joins have no SwiftUI or Android equivalent; they fall back to miter.
  lineJoin: z
    .string()
    .transform((join) =>
      join === "round" || join === "bevel" ? join : "miter",
    )
    .optional(),
  dash: z.array(finite).max(16).optional(),
  clip: z.tuple([finite, finite, finite, finite]).optional(),
};

const command = z.union([
  z.tuple([z.literal("M"), finite, finite]),
  z.tuple([z.literal("L"), finite, finite]),
  z.tuple([z.literal("Q"), finite, finite, finite, finite]),
  z.tuple([z.literal("C"), finite, finite, finite, finite, finite, finite]),
  z.tuple([z.literal("Z")]),
]);

const primitive = z.discriminatedUnion("kind", [
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

const label = z.string().max(500);

/** TanStack tooltip content: an authored string, or its structured title and rows. */
const tooltip = z.union([
  z
    .string()
    .max(1000)
    .transform((text) => ({ text, rows: [] })),
  z.object({
    title: label.optional(),
    color: color.optional(),
    rows: z
      .array(z.object({ label, value: label, color: color.optional() }))
      .max(50),
  }),
]);

const point = z
  .object({ x: finite, y: finite, color: color.optional(), tooltip })
  .transform(({ tooltip, ...anchor }) => ({ ...anchor, ...tooltip }));

/** One chart compiled at one width: a flat, paint-ordered primitive list in points, plus hover targets. */
export const chartLayout = z.object({
  width: finite,
  height: finite,
  nodes: z.array(primitive).max(MAX_PRIMITIVES),
  points: z.array(point).max(MAX_PRIMITIVES),
});

/** What the sandbox runtime emits, before color and tooltip normalization. */
export type ChartLayoutInput = z.input<typeof chartLayout>;

export type ChartLayout = z.infer<typeof chartLayout>;

const IMPORT =
  /(?<=^|;)[ \t]*import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["'][ \t]*;?/gm;

const MODULE = /^(@tanstack\/charts(\/[\w/-]+)?|d3-scale)$/;
const transpiler = new Bun.Transpiler({ loader: "ts" });

function importBinding(clause: string, specifier: string): string {
  if (!MODULE.test(specifier))
    throw new Error(
      `Cannot import "${specifier}". Only @tanstack/charts and d3-scale are available; put data inline in the code.`,
    );

  const namespace = /^\*\s+as\s+(\w+)$/.exec(clause.trim());

  if (namespace) return `const ${namespace[1]} = __crumbleImport([]);`;
  const named = /^\{([\s\S]*)\}$/.exec(clause.trim());

  if (!named?.[1])
    throw new Error(
      `Use named imports from "${specifier}", e.g. import { barY } from "${specifier}".`,
    );

  const names = named[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("type "))
    .map((part) => part.split(/\s+as\s+/));

  const bindings = names.map(([name, alias]) =>
    alias ? `${name}: ${alias}` : name,
  );

  return `const { ${bindings.join(", ")} } = __crumbleImport(${JSON.stringify(names.map(([name]) => name))});`;
}

/**
 * Accepts the module form the TanStack docs use: imports from the bundled packages and `export default` of the chart,
 * in TypeScript. The result is a plain function body for the sandbox.
 */
export function chartFunction(code: string): string {
  const body = code
    .replace(
      IMPORT,
      (_line, type: string | undefined, clause: string, specifier: string) =>
        type ? "" : importBinding(clause, specifier),
    )
    .replace(/^([ \t]*)export\s+default\s+/m, "$1return ");

  return transpiler.transformSync(`async function __chart() {\n${body}\n}`);
}

const RUNTIME_ENTRY = fileURLToPath(
  new URL("./chart-runtime.ts", import.meta.url),
);

/**
 * Runs model-written TanStack Charts code in a QuickJS sandbox and returns validated layouts. The sandbox has no I/O,
 * so the code can only build a chart from the data it contains.
 */
export class ChartCompiler {
  private readonly sandbox = new CodemodeSandbox({
    memoryLimitBytes: 128 * 1024 * 1024,
    timeoutMs: 10_000,
  });

  private runtime?: Promise<string>;

  async compile(code: string, height = DEFAULT_CHART_HEIGHT) {
    let chart: string;

    try {
      chart = chartFunction(code);
    } catch (error) {
      throw new Error(
        `Chart code does not parse: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const script = `${chart}\n${await this.bundle()}\nreturn __crumbleCompileChart(await __chart(), ${JSON.stringify(CHART_WIDTHS)}, ${height});`;
    const result = await this.sandbox.execute(script);

    if (!result.ok)
      throw new Error(`Chart code failed: ${result.error.message}`);

    if (JSON.stringify(result.value ?? null).length > MAX_BYTES)
      throw new Error(
        "The chart is too detailed to send. Aggregate or sample the data first.",
      );

    const layouts = z.array(chartLayout).min(1).safeParse(result.value);

    if (!layouts.success)
      throw new Error(
        `The chart compiled to an unsupported scene: ${z.prettifyError(layouts.error)}`,
      );

    return layouts.data;
  }

  close() {
    return this.sandbox.close();
  }

  private bundle() {
    this.runtime ??= Bun.build({
      entrypoints: [RUNTIME_ENTRY],
      format: "iife",
      target: "browser",
      minify: true,
    }).then(async (build) => {
      const output = build.outputs[0];

      if (!build.success || !output)
        throw new Error(
          `Chart runtime failed to build: ${build.logs.map((log) => log.message).join("\n")}`,
        );

      return output.text();
    });

    return this.runtime;
  }
}
