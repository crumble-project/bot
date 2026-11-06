/** Installed-library limits that matter when the owner's browser is on another machine. */
export const REMOTE_HINTS = new Map([
  [
    "openai",
    "After signing in, your browser opens a page on 127.0.0.1 that may not load. Copy that page's full address and paste it here. The server needs its internal port 1455 free; it does not need to be published.",
  ],
  [
    "radius",
    "Browser sign-in only works with a browser on the server's machine. From another device, choose device code.",
  ],
]);
