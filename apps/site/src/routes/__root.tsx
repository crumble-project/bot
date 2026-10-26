/// <reference types="vite/client" />
import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { css } from "styled-system/css";
import appCss from "~/styles.css?url";

const description =
  "Self-hosted bots with their own identity, memory, and one continuous chat with you.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Crumble" },
      { name: "description", content: description },
      { name: "color-scheme", content: "light dark" },
      { property: "og:title", content: "Crumble" },
      { property: "og:description", content: description },
      { property: "og:url", content: "https://crumbli.ng/" },
      { property: "og:image", content: "https://crumbli.ng/icon.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/crumble-icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/icon.png" },
      { rel: "canonical", href: "https://crumbli.ng/" },
    ],
  }),
  shellComponent: RootDocument,
});

const body = css({
  maxW: "calc({sizes.column} + 3rem)",
  mx: "auto",
  px: "1.5rem",
  pt: { base: "4.5rem", sm: "9rem" },
  pb: "4rem",
});

const footer = css({
  display: "flex",
  justifyContent: "space-between",
  mt: "5rem",
  fontSize: ".8125rem",
  "& a": { color: "muted", _hover: { color: "ink" } },
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className={body}>
        {children}
        <footer className={footer}>
          <Link to="/">Crumble</Link>
          <nav
            aria-label="Site"
            className={css({ display: "flex", gap: "1.25rem" })}
          >
            <a href="https://docs.crumbli.ng">Docs</a>
            <a href="https://github.com/crumble-project">GitHub</a>
          </nav>
        </footer>
        <Scripts />
      </body>
    </html>
  );
}
