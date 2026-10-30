import type { JsonValue } from "@earendil-works/chord";

/** A tool result carrying `value` both as structured output and as JSON text for the model. */
export const toolOutput = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});
