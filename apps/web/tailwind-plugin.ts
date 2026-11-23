import path from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { BunPlugin } from "bun";

const USES_TAILWIND = /@(import|reference)\s+["']tailwindcss/;

const tailwind: BunPlugin = {
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path: file }) => {
      const css = await Bun.file(file).text();

      if (!USES_TAILWIND.test(css)) {
        return { contents: css, loader: "css" };
      }

      const base = path.dirname(file);

      const compiler = await compile(css, {
        base,
        from: file,
        onDependency: () => {},
      });

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
