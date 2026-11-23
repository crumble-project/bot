import { Predicate } from "effect";

// Bun.inspect renders an Error with its stack and cause; reading `stack` alone drops the cause.
const text = (part: unknown) =>
  Predicate.isString(part) ? part : Bun.inspect(part);

const write =
  (stream: NodeJS.WriteStream) =>
  (...parts: Array<unknown>) => {
    stream.write(`${parts.map(text).join(" ")}\n`);
  };

/** Logs for code that runs outside an Effect: startup, codegen, and test fixtures. Effect code logs with `Effect.log*`. */
export const logInfo = write(process.stdout);

/** A warning for code that runs outside an Effect. */
export const logWarning = write(process.stderr);

/** A failure for code that runs outside an Effect. */
export const logError = write(process.stderr);
