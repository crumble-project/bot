import type { JsonValue } from "@earendil-works/chord";

export const toolOutput = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});
