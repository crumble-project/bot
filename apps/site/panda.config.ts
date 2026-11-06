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
          bg: { value: { base: "#FAF8F1", _osDark: "#141413" } },
          card: { value: { base: "#FFFFFF", _osDark: "#1D1D1B" } },
          border: { value: { base: "#DCEBDB", _osDark: "#33332F" } },
          ink: { value: { base: "#10261F", _osDark: "#F2F1EC" } },
          muted: { value: { base: "#346552", _osDark: "#C9C7BF" } },
          faint: { value: { base: "#346552", _osDark: "#8A8880" } },
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
