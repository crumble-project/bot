import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  presets: ["@pandacss/preset-base", "@pandacss/preset-panda"],
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: [],
  jsxFramework: "react",
  outdir: "styled-system",
  theme: {
    extend: {
      tokens: {
        fonts: {
          body: {
            value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          },
        },
        sizes: {
          column: { value: "33rem" },
        },
      },
      semanticTokens: {
        colors: {
          bg: { value: { base: "#FAF8F1", _osDark: "#10261F" } },
          card: { value: { base: "#FFFFFF", _osDark: "#17372C" } },
          border: { value: { base: "#DCEBDB", _osDark: "#346552" } },
          ink: { value: { base: "#10261F", _osDark: "#EDF5E7" } },
          muted: { value: { base: "#346552", _osDark: "#DCEBDB" } },
          faint: { value: { base: "#346552", _osDark: "#346552" } },
          mark: { value: { base: "#346552", _osDark: "#A8E2C0" } },
        },
      },
    },
  },
  globalCss: {
    html: {
      bg: "bg",
      color: "muted",
      fontFamily: "body",
      fontSize: { base: "93.75%", sm: "112.5%" },
      lineHeight: "1.65",
      WebkitFontSmoothing: "antialiased",
      textRendering: "optimizeLegibility",
      colorScheme: "light dark",
    },
    "strong, b": { color: "ink", fontWeight: "medium" },
    a: {
      color: "ink",
      textDecoration: "none",
      borderRadius: "2px",
      transition: "color .2s",
      _focusVisible: {
        outline: "2px solid",
        outlineColor: "mark",
        outlineOffset: "3px",
      },
      _motionReduce: { transition: "none" },
    },
  },
});
