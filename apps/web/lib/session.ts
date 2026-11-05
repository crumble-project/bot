const resets = new Set<() => void>();

/** Registers state bound to the signed-in account, so `resetSession` clears it. */
export function onSessionReset(reset: () => void) {
  resets.add(reset);
}

/** Drops everything the signed-in account left in this tab. */
export function resetSession() {
  for (const reset of resets) reset();
}

/** Clears the ended session and leaves for the sign-in page. */
export function signedOut() {
  resetSession();

  if (!location.pathname.endsWith("/connect"))
    window.location.assign("/connect");
}
