import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export const { useSession } = authClient;

/**
 * Whether this page can use passkeys. Browsers only offer WebAuthn in a secure
 * context, and an IP address can't be a passkey's site.
 */
export const passkeysAvailable =
  window.isSecureContext &&
  typeof PublicKeyCredential !== "undefined" &&
  !/^[\d.]+$|^\[/.test(location.hostname);

/** Error codes for a browser passkey prompt the person dismissed or that timed out. */
const DISMISSED = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

/** Whether a passkey call succeeded: false when the prompt was dismissed, and throws on any other error. */
export function passkeyDone(result: {
  error: { code?: string | undefined; message?: string | undefined } | null;
}) {
  if (!result.error) return true;

  if (DISMISSED.has(result.error.code ?? "")) return false;

  throw new Error(result.error.message);
}
