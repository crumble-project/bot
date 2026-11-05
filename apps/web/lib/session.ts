const resets = new Set<() => void>();

export function onSessionReset(reset: () => void) {
  resets.add(reset);
}

export function resetSession() {
  for (const reset of resets) reset();
}

export function signedOut() {
  resetSession();

  if (!location.pathname.endsWith("/connect"))
    window.location.assign("/connect");
}
