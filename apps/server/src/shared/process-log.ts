import { Predicate } from "effect";

const text = (part: unknown) =>
  Predicate.isString(part) ? part : Bun.inspect(part);

const write =
  (stream: NodeJS.WriteStream) =>
  (...parts: Array<unknown>) => {
    stream.write(`${parts.map(text).join(" ")}\n`);
  };

export const logInfo = write(process.stdout);

export const logWarning = write(process.stderr);

export const logError = write(process.stderr);
