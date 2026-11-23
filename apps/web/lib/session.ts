const resets = new Set<() => void>();

export function onSessionReset(reset: () => void) {
  resets.add(reset);
}

export function resetSession() {
  for (const reset of resets) {
    reset();
  }
}

export function returnPath(next: string | null | undefined): string {
  if (!next?.startsWith("/")) {
    return "/";
  }

  if (next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }

  if (next === "/connect" || next.startsWith("/connect?")) {
    return "/";
  }

  return next;
}

export function connectPath(path: string): string {
  const next = returnPath(path);

  return next === "/"
    ? "/connect"
    : `/connect?next=${encodeURIComponent(next)}`;
}

export function signedOut() {
  resetSession();

  if (!location.pathname.endsWith("/connect")) {
    window.location.assign(
      connectPath(location.pathname + location.search + location.hash),
    );
  }
}
