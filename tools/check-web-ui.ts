import { webUIRoutes } from "../apps/server/src/app/web-ui";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: webUIRoutes,
  fetch: () => new Response("Not found", { status: 404 }),
});

try {
  const response = await fetch(new URL("/ui", server.url), {
    signal: AbortSignal.timeout(30_000),
  });

  const html = await response.text();

  if (!response.ok || !html.includes('<div id="root">')) {
    throw new Error(
      `UI HTML missing: HTTP ${response.status}, ${html.length} bytes`,
    );
  }

  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)];

  if (!assets.some((match) => match[1]?.endsWith(".js"))) {
    throw new Error("UI JavaScript bundle missing from HTML");
  }

  if (!assets.some((match) => match[1]?.endsWith(".css"))) {
    throw new Error("UI stylesheet missing from HTML");
  }

  for (const [, asset] of assets) {
    if (!asset) continue;

    const result = await fetch(new URL(asset, response.url), {
      signal: AbortSignal.timeout(30_000),
    });

    const body = await result.text();
    const contentType = result.headers.get("content-type") ?? "";
    const expectedType = asset.endsWith(".css") ? "text/css" : "javascript";

    if (!result.ok || !body.length || !contentType.includes(expectedType)) {
      throw new Error(`UI asset missing: ${asset}, HTTP ${result.status}`);
    }

    console.log(`PASS ${asset}: ${body.length} bytes`);
  }

  console.log(`PASS /ui: ${html.length} bytes`);
} finally {
  await server.stop(true);
}
