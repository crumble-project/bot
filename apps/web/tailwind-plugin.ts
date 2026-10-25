import path from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { BunPlugin } from "bun";

const USES_TAILWIND = /@(import|reference)\s+["']tailwindcss/;

/**
 * Compiles the web UI's stylesheet with the project's own Tailwind. `bun-plugin-tailwind` bundles Tailwind 4.1 and
 * silently drops newer utilities that shadcn components use.
 */
const tailwind: BunPlugin = {
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path: file }) => {
      const css = await Bun.file(file).text();

      if (!USES_TAILWIND.test(css)) return { contents: css, loader: "css" };

      const base = path.dirname(file);

      const compiler = await compile(css, {
        base,
        from: file,
        onDependency: () => {},
      });

      // As Tailwind's own integrations: `@import "tailwindcss" source(...)` sets the root, and `none` turns it off.
      const root =
        compiler.root === "none"
          ? []
          : [
              {
                ...(compiler.root ?? { base, pattern: "**/*" }),
                negated: false,
              },
            ];

      const candidates = new Scanner({
        sources: [...root, ...compiler.sources],
      }).scan();

      return { contents: compiler.build(candidates), loader: "css" };
    });
  },
};

export default tailwind;
