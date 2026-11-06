import { errorText } from "../shared/errors";
import { fileURLToPath } from "node:url";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { z } from "zod";
import { chartLayout } from "../contract/chart";

/** Layout widths that fit inside client cards unscaled: a phone column and the desktop reply. */
export const CHART_WIDTHS = [320, 520];
export const DEFAULT_CHART_HEIGHT = 240;
const MAX_BYTES = 600_000;

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
      throw new Error(`Chart code does not parse: ${errorText(error)}`);
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
