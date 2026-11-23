export { cn } from "cn";

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  bytes[6] = ((bytes.at(6) ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes.at(8) ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

export const numberWord = (count: number) =>
  NUMBER_WORDS[count] ?? String(count);

export function plainMarkdown(markdown: string) {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/[*_`#>[\]()]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}
