import { useEffect, useSyncExternalStore } from "react";
import { AVATAR_MATERIALS } from "@crumble/server/contract/user-preferences";
import type { AvatarMaterial } from "@crumble/server/contract/user-preferences";
import { authClient } from "@/lib/auth-client";

const STORAGE_KEY = "crumble-avatar-material";

const listeners = new Set<() => void>();

const isMaterial = (value: unknown): value is AvatarMaterial =>
  AVATAR_MATERIALS.some((material) => material === value);

function stored(): AvatarMaterial {
  const value = localStorage.getItem(STORAGE_KEY);

  return isMaterial(value) ? value : "flat";
}

let current = stored();

function adopt(material: AvatarMaterial) {
  if (material === current) {
    return;
  }

  current = material;
  localStorage.setItem(STORAGE_KEY, material);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export const useAvatarMaterial = () =>
  useSyncExternalStore(subscribe, () => current);

export async function setAvatarMaterial(material: AvatarMaterial) {
  adopt(material);
  await authClient.updateUser({ avatarMaterial: material });
}

export function useAccountAvatarMaterial() {
  const session = authClient.useSession();
  const material = session.data?.user.avatarMaterial;

  useEffect(() => {
    if (isMaterial(material)) {
      adopt(material);
    }
  }, [material]);

  return useAvatarMaterial();
}
