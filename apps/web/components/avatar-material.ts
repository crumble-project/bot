import { createContext } from "react";
import type { AvatarMaterial } from "@crumble/server/contract/user-preferences";

export const AvatarMaterialContext = createContext<AvatarMaterial>("flat");
