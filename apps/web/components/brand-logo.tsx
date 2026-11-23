import type { SimpleIcon } from "simple-icons";

const channel = (hex: string, at: number) =>
  Number.parseInt(hex.slice(at, at + 2), 16) / 255;

const isDark = (hex: string) =>
  0.2126 * channel(hex, 0) +
    0.7152 * channel(hex, 2) +
    0.0722 * channel(hex, 4) <
  0.2;

export function BrandLogo({ icon }: { icon: SimpleIcon }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        d={icon.path}
        fill={isDark(icon.hex) ? "currentColor" : `#${icon.hex}`}
      />
    </svg>
  );
}

export function MarkupLogo({ svg }: { svg: string }) {
  return (
    <span
      aria-hidden
      className="flex size-4 [&>svg]:size-full"

      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
