export type SourceComment = { offset: number; length: number };

type Syntax = "json" | "css" | "sql" | "hash" | "shell" | "python" | "markup";

function quotedEnd(source: string, start: number, syntax: Syntax) {
  const quote = source[start] ?? "";
  const triple =
    (syntax === "python" || syntax === "hash") &&
    source.slice(start, start + 3) === quote.repeat(3);
  const delimiter = triple ? quote.repeat(3) : quote;
  let offset = start + delimiter.length;
  while (offset < source.length) {
    if (
      source[offset] === "\\" &&
      syntax !== "sql" &&
      !(syntax === "hash" && quote === "'")
    ) {
      offset += 2;
    } else if (source.startsWith(delimiter, offset)) {
      if (
        (syntax === "sql" || (syntax === "hash" && quote === "'")) &&
        !triple &&
        source[offset + 1] === quote
      ) {
        offset += 2;
      } else {
        return offset + delimiter.length;
      }
    } else {
      offset += 1;
    }
  }
  return source.length;
}

export function sourceSyntax(file: string): Syntax | undefined {
  if (/\.(json|jsonc|webmanifest)$/.test(file)) {
    return "json";
  }
  if (file.endsWith(".css")) {
    return "css";
  }
  if (file.endsWith(".sql")) {
    return "sql";
  }
  if (file.endsWith(".py")) {
    return "python";
  }
  if (/\.(html|xml|svg)$/.test(file)) {
    return "markup";
  }
  if (/\.(sh|bash)$/.test(file) || /^\.githooks\//.test(file)) {
    return "shell";
  }
  if (/\.(yaml|yml|toml|desktop)$/.test(file)) {
    return "hash";
  }
  if (/(^|\/)(Dockerfile|\.gitignore|\.dockerignore)$/.test(file)) {
    return "hash";
  }
  return undefined;
}

export function sourceComments(
  file: string,
  source: string,
): Array<SourceComment> {
  const syntax = sourceSyntax(file);
  if (!syntax) {
    return [];
  }
  const result: Array<SourceComment> = [];
  const lineOnly = /(^|\/)(Dockerfile|\.gitignore|\.dockerignore)$/.test(file);
  let offset = 0;
  let lineStart = 0;
  let yamlScalarIndent: number | undefined;
  while (offset < source.length) {
    if (source[offset] === "\n") {
      offset += 1;
      lineStart = offset;
      continue;
    }
    if (/\.ya?ml$/.test(file) && offset === lineStart) {
      const end = source.indexOf("\n", offset);
      const line = source.slice(offset, end < 0 ? source.length : end);
      const indent = line.match(/^ */)?.[0].length ?? 0;
      if (
        yamlScalarIndent !== undefined &&
        (!line.trim() || indent > yamlScalarIndent)
      ) {
        offset += line.length;
        continue;
      }
      yamlScalarIndent = undefined;
      if (/^[^#]*:\s*[|>][\d+-]*\s*(?:#.*)?$/.test(line)) {
        yamlScalarIndent = indent;
      }
    }
    const char = source[offset];
    const next = source[offset + 1];
    if (
      syntax === "css" &&
      source.slice(offset, offset + 4).toLowerCase() === "url("
    ) {
      offset += 4;
      while (offset < source.length && source[offset] !== ")") {
        if (source[offset] === "'" || source[offset] === '"') {
          offset = quotedEnd(source, offset, syntax);
        } else {
          offset += source[offset] === "\\" ? 2 : 1;
        }
      }
      offset += 1;
      continue;
    }
    const startsQuote =
      (char === "'" || char === '"') &&
      !(
        syntax === "hash" &&
        /\.ya?ml$/.test(file) &&
        /[\w]/.test(source[offset - 1] ?? "")
      );
    if (startsQuote || (syntax === "shell" && char === "`")) {
      const end = quotedEnd(source, offset, syntax);
      const newline = source.lastIndexOf("\n", end - 1);
      if (newline >= lineStart) {
        lineStart = newline + 1;
      }
      offset = end;
      continue;
    }
    if (syntax === "sql" && (char === "`" || char === "[")) {
      const close = char === "[" ? "]" : "`";
      const end = source.indexOf(close, offset + 1);
      offset = end < 0 ? source.length : end + 1;
      continue;
    }
    if (syntax === "markup" && source.startsWith("<!--", offset)) {
      const end = source.indexOf("-->", offset + 4);
      const length = end < 0 ? source.length - offset : end + 3 - offset;
      result.push({ offset, length });
      offset += length;
      continue;
    }
    const slashComment =
      (syntax === "json" && char === "/" && next === "/") ||
      (syntax === "sql" && char === "-" && next === "-");
    const blockComment =
      (syntax === "json" || syntax === "css" || syntax === "sql") &&
      char === "/" &&
      next === "*";
    const hashComment =
      char === "#" &&
      (syntax === "hash" || syntax === "shell" || syntax === "python") &&
      !(offset === 0 && next === "!") &&
      (syntax === "python" ||
        (lineOnly
          ? source.slice(lineStart, offset).trim() === ""
          : offset === lineStart ||
            /[\s;|&()]/.test(source[offset - 1] ?? "")));
    if (slashComment || blockComment || hashComment) {
      const end = source.indexOf(blockComment ? "*/" : "\n", offset + 2);
      const length =
        end < 0
          ? source.length - offset
          : end + (blockComment ? 2 : 0) - offset;
      result.push({ offset, length });
      offset += length;
    } else {
      offset += 1;
    }
  }
  return result;
}
