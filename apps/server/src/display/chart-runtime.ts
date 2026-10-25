/**
 * Bundled into the chart sandbox, never imported by the server. It exposes the authoring API to rewritten imports and
 * flattens compiled scenes into the primitive list clients draw. The server validates what it emits (`chartLayout`).
 */
import * as core from "@tanstack/charts";
import { sunburst } from "@tanstack/charts/hierarchy/sunburst";
import { treemap } from "@tanstack/charts/hierarchy/treemap";
import { sankeyDiagram } from "@tanstack/charts/network/sankey";
import * as polar from "@tanstack/charts/polar";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { createChartTooltipContent } from "@tanstack/charts/tooltip/model";
import type {
  ChartDefinition,
  ChartPoint,
  ChartScene,
  ChartTooltipOptions,
  SceneNode,
  SceneStyle,
} from "@tanstack/charts";
import { scaleLog, scaleSqrt, scaleTime, scaleUtc } from "d3-scale";
import svgpath from "svgpath";
import type { ChartLayoutInput } from "./charts";

type Primitive = ChartLayoutInput["nodes"][number];

type Command = Extract<Primitive, { kind: "path" }>["commands"][number];

type Paint = Pick<
  Primitive,
  | "fill"
  | "fillOpacity"
  | "stroke"
  | "strokeOpacity"
  | "strokeWidth"
  | "opacity"
  | "lineCap"
  | "lineJoin"
  | "dash"
>;

type Placement = {
  dx: number;
  dy: number;
  clip?: [number, number, number, number] | undefined;
  paint: Paint;
};

/** Theme tokens clients resolve per appearance. */
const theme = {
  foreground: "currentColor",
  muted: "currentColor",
  grid: "currentColor",
  background: "transparent",
  palette: Array.from({ length: 8 }, (_, index) => `series-${index + 1}`),
};

const charts = {
  ...core,
  ...polar,
  treemap,
  sunburst,
  sankeyDiagram,
  scaleBand,
  scaleLinear,
  scaleOrdinal,
  scalePoint,
  scaleLog,
  scaleSqrt,
  scaleTime,
  scaleUtc,
  tooltip,
};

const round = (value: number) => Math.round(value * 100) / 100;

/** QuickJS has no Intl, so default tooltip numbers arrive with float noise such as 56.35859999999999. */
const tidy = (value: string) =>
  /^-?\d+\.\d{4,}$/.test(value)
    ? String(Math.round(Number(value) * 1000) / 1000)
    : value;

function inherit(parent: Paint, style: SceneStyle | undefined): Paint {
  if (!style) return parent;

  // SVG paint inherits into children; group opacity composites, which multiplying approximates for chart marks.
  return {
    fill: style.fill ?? parent.fill,
    fillOpacity: style.fillOpacity ?? parent.fillOpacity,
    stroke: style.stroke ?? parent.stroke,
    strokeOpacity: style.strokeOpacity ?? parent.strokeOpacity,
    strokeWidth: style.strokeWidth ?? parent.strokeWidth,
    opacity:
      style.opacity === undefined
        ? parent.opacity
        : (parent.opacity ?? 1) * style.opacity,
    lineCap: style.lineCap ?? parent.lineCap,
    lineJoin: style.lineJoin ?? parent.lineJoin,
    dash:
      style.strokeDasharray === undefined
        ? parent.dash
        : style.strokeDasharray === "none"
          ? undefined
          : style.strokeDasharray.split(/[\s,]+/).map(Number),
  };
}

function pathCommands(d: string, dx: number, dy: number): Command[] {
  const commands: Command[] = [];

  svgpath(d)
    .abs()
    .unshort()
    .unarc()
    .translate(dx, dy)
    .iterate((segment, _index, x, y) => {
      switch (segment[0]) {
        case "M":
        case "L":
          commands.push([segment[0], round(segment[1]), round(segment[2])]);
          break;
        case "H":
          commands.push(["L", round(segment[1]), round(y)]);
          break;
        case "V":
          commands.push(["L", round(x), round(segment[1])]);
          break;
        case "Q": {
          const [, x1, y1, qx, qy] = segment;

          commands.push(["Q", round(x1), round(y1), round(qx), round(qy)]);
          break;
        }

        case "C": {
          const [, x1, y1, x2, y2, cx, cy] = segment;

          commands.push([
            "C",
            round(x1),
            round(y1),
            round(x2),
            round(y2),
            round(cx),
            round(cy),
          ]);
          break;
        }

        case "Z":
        case "z":
          commands.push(["Z"]);
          break;
        default:
          // abs(), unshort(), and unarc() leave only the cases above.
          break;
      }
    });

  return commands;
}

function ring(
  points: readonly (readonly [number, number])[],
  dx: number,
  dy: number,
  closed: boolean,
): Command[] {
  const commands: Command[] = points.map(([x, y], index) => [
    index === 0 ? "M" : "L",
    round(x + dx),
    round(y + dy),
  ]);

  if (closed && commands.length) commands.push(["Z"]);

  return commands;
}

/** Corners as cubic quarter-circle approximations, in top-left, top-right, bottom-right, bottom-left order. */
function roundedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  radii: readonly number[],
): Command[] {
  const limit = Math.min(width, height) / 2;

  const [tl = 0, tr = 0, br = 0, bl = 0] = radii.map((radius) =>
    Math.max(0, Math.min(radius, limit)),
  );

  const k = 1 - 0.5523;
  const left = round(x);
  const top = round(y);
  const right = round(x + width);
  const bottom = round(y + height);
  const at = (value: number) => round(value);

  return [
    ["M", at(x + tl), top],
    ["L", at(x + width - tr), top],
    [
      "C",
      at(x + width - tr * k),
      top,
      right,
      at(y + tr * k),
      right,
      at(y + tr),
    ],
    ["L", right, at(y + height - br)],
    [
      "C",
      right,
      at(y + height - br * k),
      at(x + width - br * k),
      bottom,
      at(x + width - br),
      bottom,
    ],
    ["L", at(x + bl), bottom],
    [
      "C",
      at(x + bl * k),
      bottom,
      left,
      at(y + height - bl * k),
      left,
      at(y + height - bl),
    ],
    ["L", left, at(y + tl)],
    ["C", left, at(y + tl * k), at(x + tl * k), top, at(x + tl), top],
    ["Z"],
  ];
}

function primitive(node: SceneNode, place: Placement): Primitive | undefined {
  const paint = inherit(place.paint, node.style);
  const { dx, dy, clip } = place;

  if (paint.opacity === 0) return undefined;

  switch (node.kind) {
    case "rule":
      return {
        kind: "line",
        x1: round(node.x1 + dx),
        y1: round(node.y1 + dy),
        x2: round(node.x2 + dx),
        y2: round(node.y2 + dy),
        ...paint,
        clip,
      };
    case "polyline":
      return {
        kind: "path",
        commands: node.path
          ? pathCommands(node.path, dx, dy)
          : ring(node.points, dx, dy, false),
        ...paint,
        fill: "none",
        clip,
      };
    case "area":
      return {
        kind: "path",
        commands: node.polygons
          ? node.polygons.flatMap((polygon) =>
              polygon.flatMap((rings) => ring(rings, dx, dy, true)),
            )
          : node.path
            ? pathCommands(node.path, dx, dy)
            : ring(node.points, dx, dy, true),
        evenOdd: node.polygons !== undefined,
        ...paint,
        clip,
      };
    case "dot":
      return {
        kind: "circle",
        x: round(node.x + dx),
        y: round(node.y + dy),
        radius: round(node.radius),
        ...paint,
        clip,
      };
    case "rect":
      if (node.cornerRadii && new Set(node.cornerRadii).size > 1)
        return {
          kind: "path",
          commands: roundedRect(
            node.x + dx,
            node.y + dy,
            node.width,
            node.height,
            node.cornerRadii,
          ),
          ...paint,
          clip,
        };

      return {
        kind: "rect",
        x: round(node.x + dx),
        y: round(node.y + dy),
        width: round(node.width),
        height: round(node.height),
        radius: round(node.cornerRadii?.[0] ?? node.radius ?? 0),
        ...paint,
        clip,
      };
    case "label":
      return {
        kind: "text",
        x: round(node.x + dx),
        y: round(node.y + dy),
        text: node.text,
        anchor: node.anchor ?? "start",
        baseline: node.baseline ?? "auto",
        rotate: node.rotate ?? 0,
        size: node.fontSize ?? 11,
        weight: node.fontWeight ?? 400,
        ...paint,
        clip,
      };
    case "group":
      return undefined;
  }
}

/** Groups dissolve into absolute positions, inherited paint, and a clip rectangle per primitive. */
function flatten(node: SceneNode, place: Placement, out: Primitive[]) {
  if (node.kind !== "group") {
    const drawn = primitive(node, place);

    if (drawn) out.push(drawn);

    return;
  }

  // Focus layers paint only for the focused point; clients draw their own hover marker instead.
  if (node.focus || node.className?.includes("focus-layer")) return;
  const dx = place.dx + (node.translateX ?? 0);
  const dy = place.dy + (node.translateY ?? 0);

  const clip: Placement["clip"] = node.clip
    ? [
        round(node.clip.x + dx),
        round(node.clip.y + dy),
        round(node.clip.width),
        round(node.clip.height),
      ]
    : place.clip;

  const next = { dx, dy, clip, paint: inherit(place.paint, node.style) };

  for (const child of node.children) flatten(child, next, out);
}

function tooltipContent(
  point: ChartPoint,
  scene: ChartScene,
  options: ChartTooltipOptions | undefined,
) {
  const content = createChartTooltipContent([point], scene, false, options);

  if (!(content instanceof Object)) return content;

  return {
    ...content,
    color: content.color ?? point.color,
    rows: content.rows.map((row) => ({ ...row, value: tidy(row.value) })),
  };
}

/** Authored formatting from `tooltip: { use: tooltip, format }`; clients draw the tooltip itself. */
function tooltipOptions(
  definition: ChartDefinition,
): ChartTooltipOptions | undefined {
  const input = definition.tooltip;

  return input && "use" in input ? input : undefined;
}

function compile(
  definition: ChartDefinition | undefined,
  widths: number[],
  height: number,
): ChartLayoutInput[] {
  if (!definition)
    throw new Error("Export the chart: export default defineChart({...}).");
  const runtime = core.createChartRuntime({ defaultTheme: theme });
  const options = tooltipOptions(definition);

  const layouts: ChartLayoutInput[] = [];
  const errors: unknown[] = [];

  try {
    // A width the library cannot lay out is dropped; clients scale another layout to fit.
    for (const width of widths)
      try {
        layouts.push(
          layout(runtime.render(definition, { width, height }), options),
        );
      } catch (error) {
        errors.push(error);
      }
  } finally {
    runtime.destroy();
  }

  if (!layouts.length) throw errors[0];

  return layouts;
}

function layout(
  scene: ChartScene,
  options: ChartTooltipOptions | undefined,
): ChartLayoutInput {
  const nodes: Primitive[] = [];

  for (const node of scene.nodes)
    flatten(node, { dx: 0, dy: 0, paint: {} }, nodes);

  return {
    width: scene.width,
    height: scene.height,
    nodes,
    points: scene.points.map((point) => ({
      x: round(point.x),
      y: round(point.y),
      color: point.color,
      tooltip: tooltipContent(point, scene, options),
    })),
  };
}

/** Backs rewritten imports, naming a missing export instead of failing later as "not a function". */
function importNames(names: string[]) {
  const missing = names.filter((name) => !(name in charts));

  if (missing.length)
    throw new Error(
      `${missing.join(", ")} not available. Crumble charts bundle @tanstack/charts (root, polar, treemap, sunburst, sankey, compact scales, tooltip) and d3-scale (scaleUtc, scaleTime, scaleLog, scaleSqrt).`,
    );

  return charts;
}

Object.assign(globalThis, {
  __crumbleImport: importNames,
  __crumbleCompileChart: compile,
});
