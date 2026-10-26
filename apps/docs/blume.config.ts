import { defineConfig } from "blume";

export default defineConfig({
  title: "Crumble",
  description:
    "Self-hosted personal AI bots with persistent memory, continuous chats, and isolated workspaces.",
  logo: { image: "/icon.svg", text: "Crumble" },
  content: { root: "content" },
  theme: {
    accent: { light: "#17372C", dark: "#A8E2C0" },
    background: { light: "#FAF8F1", dark: "#10261F" },
    radius: "md",
    mode: "system",
  },
  navigation: { sidebar: { display: "group" } },
  deployment: { site: "https://docs.crumbli.ng" },
  redirects: [
    { from: "/features", to: "/concepts" },
    { from: "/features/workspaces", to: "/concepts/workspaces" },
    { from: "/architecture", to: "/contributing/architecture" },
  ],
  footer: {
    links: [
      { label: "GitHub", href: "https://github.com/crumble-project" },
      {
        label: "Specifications",
        href: "https://github.com/crumble-project/spec",
      },
    ],
  },
});
