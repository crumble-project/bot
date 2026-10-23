import path from "node:path";
import { fileURLToPath } from "node:url";
import webUI from "../web/index.html";

/** Where the browser loads Pele's ES modules from; `web/markdown.tsx` imports this path at runtime. */
export const PELE_PREFIX = "/ui-modules/pele";

const PELE = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("pele/package.json"))),
  "dist/esm",
);

/** A Pele module under its ESM build, or undefined for any other path. */
function peleFile(requested: string) {
  const relative = path.posix.normalize(decodeURIComponent(requested));

  if (!relative.endsWith(".js")) return undefined;

  const file = path.resolve(PELE, relative);

  return file.startsWith(`${PELE}${path.sep}`) ? file : undefined;
}

/**
 * The web UI and the modules it loads on demand. Bun bundles the UI without code splitting, so
 * Pele's Mermaid renderer is served unbundled and each diagram type loads only when a chat shows one.
 */
export const webUIRoutes = {
  "/ui": webUI,
  "/ui/*": webUI,
  [`${PELE_PREFIX}/*`]: async (request: Request) => {
    const file = peleFile(
      new URL(request.url).pathname.slice(PELE_PREFIX.length + 1),
    );

    if (!file || !(await Bun.file(file).exists()))
      return new Response("Not found", { status: 404 });

    return new Response(Bun.file(file), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    });
  },
};
