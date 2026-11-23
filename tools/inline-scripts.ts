export function inlineScripts(source: string) {
  return [
    ...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
  ].flatMap((match) => {
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? "")?.[1];
    const script = match[2] ?? "";
    if (
      !script.trim() ||
      (type &&
        !/^(module|(?:text|application)\/(?:java|ecma)script)$/i.test(type))
    ) {
      return [];
    }
    return [
      { source: script, offset: match.index + match[0].indexOf(">") + 1 },
    ];
  });
}
