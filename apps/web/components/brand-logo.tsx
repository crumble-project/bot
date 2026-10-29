import type { SimpleIcon } from "simple-icons";

// Near-black marks would vanish on the dark background, so they take the text color instead.
const isDark = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  );

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.2;
};

/** A brand's mark from Simple Icons, in its brand color. */
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

/** A logo shipped as SVG markup in a bundled icon package; its `currentColor` follows the text color. */
export function MarkupLogo({ svg }: { svg: string }) {
  return (
    <span
      aria-hidden
      className="flex size-4 [&>svg]:size-full"
      // Markup comes from an icon package bundled at build time, never from users or the server.
      // react-doctor-disable-next-line dangerous-html-sink
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
