/**
 * The modules the chart sandbox bundles. A new chart family goes here, in `chart-runtime.ts`'s imports, and in the
 * `show` tool's description, and `charts.test.ts` fails until all three agree.
 */
export const CHART_MODULES = [
  "@tanstack/charts",
  "@tanstack/charts/polar",
  "@tanstack/charts/hierarchy/treemap",
  "@tanstack/charts/hierarchy/sunburst",
  "@tanstack/charts/network/sankey",
  "@tanstack/charts/scales/linear",
  "@tanstack/charts/scales/band",
  "@tanstack/charts/scales/point",
  "@tanstack/charts/scales/ordinal",
  "@tanstack/charts/tooltip",
  "@tanstack/charts/tooltip/model",
  "d3-scale",
] as const;
