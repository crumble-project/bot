import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const WEB = path.resolve(import.meta.dir, "..");
const NOTICES = path.resolve(WEB, "../../THIRD_PARTY_NOTICES.md");
const STYLESHEET = path.join(WEB, "shadcn-tailwind.css");
const REGISTRY = "https://ui.shadcn.com/r/styles";
const TABLER = "@tabler/icons-react";

const configSchema = z.object({
  style: z.string(),
  rsc: z.boolean(),
  rtl: z.boolean(),
  iconLibrary: z.string(),
  aliases: z.object({ ui: z.string(), hooks: z.string(), lib: z.string() }),
});

type Config = z.infer<typeof configSchema>;

const fileSchema = z.object({ path: z.string(), content: z.string() });

type RegistryFile = z.infer<typeof fileSchema>;

const itemSchema = z.object({
  dependencies: z.array(z.string()).default([]),
  registryDependencies: z.array(z.string()).default([]),
  files: z.array(fileSchema).default([]),
  cssVars: z.unknown().optional(),
  css: z.unknown().optional(),
  envVars: z.unknown().optional(),
  tailwind: z.unknown().optional(),
});

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
});

const npmVersionSchema = z.object({
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
});

const fail = (message: string): never => {
  throw new Error(message);
};

async function readConfig() {
  const config = configSchema.parse(
    await Bun.file(path.join(WEB, "components.json")).json(),
  );

  if (config.rtl) fail("Right-to-left components are not supported");

  if (config.iconLibrary !== "tabler")
    fail(
      `Only the tabler icon library is supported, not ${config.iconLibrary}`,
    );

  return config;
}

async function fetchItem(name: string, config: Config) {
  // Names reach the URL, and registry dependencies come from the server.
  if (!/^[a-z0-9-]+$/.test(name))
    fail(`${name}: only registry names of this style are supported`);

  const url = `${REGISTRY}/${config.style}/${name}.json`;
  const response = await fetch(url);

  if (response.status === 404)
    fail(`${name}: not in the ${config.style} registry`);

  if (!response.ok) fail(`${url}: HTTP ${response.status}`);

  const item = itemSchema.parse(await response.json());

  // These change project config, which this tool leaves to a person.
  for (const key of ["cssVars", "css", "envVars", "tailwind"] as const)
    if (item[key])
      console.warn(
        `${name} also wants ${key}, apply by hand:\n${JSON.stringify(item[key], null, 2)}`,
      );

  return { ...item, name };
}

/** A component and everything it needs, dependencies first. */
async function resolve(names: string[], config: Config) {
  const items = new Map<string, Awaited<ReturnType<typeof fetchItem>>>();

  async function visit(name: string) {
    if (items.has(name)) return;

    const item = await fetchItem(name, config);
    items.set(name, item);

    await Promise.all(item.registryDependencies.map(visit));
  }

  await Promise.all(names.map(visit));

  return [...items.values()];
}

function target(file: RegistryFile, config: Config) {
  // The path comes from the server, so it must not leave the web app.
  const match = new RegExp(
    `^registry/${config.style}/(ui|hooks|lib)/([\\w.-]+)$`,
  ).exec(file.path);

  if (!match?.[1] || !match[2] || match[2].startsWith("."))
    return fail(`Unexpected registry path: ${file.path}`);

  const folder =
    config.aliases[
      match[1] === "ui" ? "ui" : match[1] === "hooks" ? "hooks" : "lib"
    ];

  return path.join(WEB, folder.replace(/^@\//, ""), match[2]);
}

// `cn-*` classes are hooks for style presets; only the heading font maps to a real class.
const replaceStyleClasses = (source: string) =>
  source
    .replace(/(?<![\w/-])cn-font-heading\b/g, "font-heading")
    .replace(/(?<![\w/-])cn-[a-z0-9-]+ ?/g, "")
    .replace(/\s*\bclassName=""/g, "");

function replaceIcons(source: string) {
  const icons = new Set<string>();

  const replaced = source.replace(
    /<IconPlaceholder\b([^>]*?)\/>/gs,
    (_, props: string) => {
      const icon = /\btabler="(\w+)"/.exec(props)?.[1];

      if (!icon) return fail(`Icon without a tabler name: ${props}`);

      icons.add(icon);

      const rest = props
        .replace(/\s*\b(lucide|tabler|hugeicons|phosphor|remixicon)="\w+"/g, "")
        .trim();

      return rest ? `<${icon} ${rest} />` : `<${icon} />`;
    },
  );

  if (!icons.size) return replaced;

  return replaced.replace(
    /\n+import \{ IconPlaceholder \} from "[^"]+";?$/m,
    `\nimport { ${[...icons].join(", ")} } from "${TABLER}"`,
  );
}

function transform(source: string, config: Config) {
  const { ui, hooks, lib } = config.aliases;

  const registry = `@/registry/${config.style}`;

  let output = replaceStyleClasses(replaceIcons(source))
    .replaceAll(`${registry}/ui/`, `${ui}/`)
    .replaceAll(`${registry}/hooks/`, `${hooks}/`)
    .replaceAll(`${registry}/lib/`, `${lib}/`);

  if (!config.rsc) output = output.replace(/^"use client"\s*/, "");

  // Writing the rest as the upstream CLI would is not safe to guess, so a new form stops here.
  const unknown = [...output.matchAll(/from "(@\/(?:registry|app)[^"]*)"/g)];

  if (unknown.length || output.includes("IconPlaceholder"))
    fail(`Unknown registry import: ${unknown[0]?.[1] ?? "IconPlaceholder"}`);

  return output;
}

async function format(files: string[]) {
  const proc = Bun.spawn(["bun", "fmt", ...files], { stdout: "ignore" });

  if ((await proc.exited) !== 0) fail("bun fmt failed");
}

async function add(names: string[], overwrite: boolean) {
  const config = await readConfig();
  const items = await resolve(names, config);

  const { dependencies } = manifestSchema.parse(
    await Bun.file(path.join(WEB, "package.json")).json(),
  );

  const writes = items
    .flatMap((item) =>
      item.files.map((file) => ({ item, to: target(file, config), file })),
    )
    // Dependencies that exist may hold local edits, so `--overwrite` covers named components only.
    .filter(({ item, to }) => {
      if (!existsSync(to) || (overwrite && names.includes(item.name)))
        return true;

      console.log(`Kept ${path.relative(WEB, to)}`);

      return false;
    })
    .map(({ to, file }) => ({ to, content: transform(file.content, config) }));

  // Every file is transformed before any is written, so a failure leaves the tree alone.
  for (const { to, content } of writes) {
    mkdirSync(path.dirname(to), { recursive: true });
    await Bun.write(to, content);
    console.log(`Wrote ${path.relative(WEB, to)}`);
  }

  if (writes.length) await format(writes.map(({ to }) => to));

  const missing = [
    ...new Set(items.flatMap((item) => item.dependencies)),
  ].filter((name) => !(name.replace(/(?<=.)@.*$/, "") in dependencies));

  if (missing.length)
    console.log(
      `Missing packages, from apps/web: bun add ${missing.join(" ")}`,
    );
}

/** The stylesheet isn't in the registry, only in the npm package, so it is read from the verified tarball. */
async function updateStylesheet(version: string) {
  const url = `https://registry.npmjs.org/shadcn/${encodeURIComponent(version)}`;
  const response = await fetch(url);

  if (!response.ok) fail(`${url}: HTTP ${response.status}`);

  const { dist } = npmVersionSchema.parse(await response.json());

  const bytes = new Uint8Array(await (await fetch(dist.tarball)).arrayBuffer());
  const digest = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");

  if (`sha512-${digest}` !== dist.integrity)
    fail(`shadcn ${version}: tarball does not match its published integrity`);

  const files = await new Bun.Archive(bytes).files("package/dist/tailwind.css");
  const stylesheet = files.get("package/dist/tailwind.css");

  if (!stylesheet) return fail(`shadcn ${version} has no dist/tailwind.css`);

  await Bun.write(STYLESHEET, stylesheet);
  await format([STYLESHEET]);

  const notices = await Bun.file(NOTICES).text();
  const pinned = /`shadcn` \S+ package/;

  if (!pinned.test(notices))
    fail("THIRD_PARTY_NOTICES.md has no shadcn version");

  await Bun.write(
    NOTICES,
    notices.replace(pinned, `\`shadcn\` ${version} package`),
  );

  console.log(`Updated ${path.relative(WEB, STYLESHEET)} to shadcn ${version}`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { overwrite: { type: "boolean" }, css: { type: "string" } },
});

if (values.css) await updateStylesheet(values.css);
else if (positionals.length) await add(positionals, values.overwrite === true);
else
  fail(
    "Usage: bun run ui:add [--overwrite] <component...>\n       bun run ui:add --css <version>",
  );
