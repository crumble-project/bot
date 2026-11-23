import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { userPreferenceFields } from "@crumble/server/contract/user-preferences";

export const authClient = createAuthClient({
  plugins: [
    passkeyClient(),
    adminClient(),
    inferAdditionalFields({ user: userPreferenceFields }),
  ],
});

export const INVITE_HEADER = "x-crumble-invite";

export const { useSession } = authClient;

export const useIsAdmin = () => useSession().data?.user.role === "admin";

export const passkeysAvailable =
  window.isSecureContext &&
  typeof PublicKeyCredential !== "undefined" &&
  !/^[\d.]+$|^\[/.test(location.hostname);

const DISMISSED = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

export function passkeyDone(result: {
  error: { code?: string | undefined; message?: string | undefined } | null;
}) {
  if (!result.error) {
    return true;
  }

  if (DISMISSED.has(result.error.code ?? "")) {
    return false;
  }

  throw new Error(result.error.message);
}
