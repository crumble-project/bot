import { IconMessages } from "@tabler/icons-react";
import { siDiscord, type SimpleIcon } from "simple-icons";
import { BrandLogo } from "@/components/brand-logo";

const GATEWAYS = new Map<string, { label: string; icon: SimpleIcon }>([
  ["discord", { label: "Discord", icon: siDiscord }],
]);

/** A message gateway's name by its ID; an unknown gateway keeps its ID. */
export const gatewayLabel = (id: string) => GATEWAYS.get(id)?.label ?? id;

/** A message gateway's brand logo, or a generic chat icon for one without it. */
export function GatewayIcon({ id }: { id: string }) {
  const icon = GATEWAYS.get(id)?.icon;

  return icon ? <BrandLogo icon={icon} /> : <IconMessages className="size-4" />;
}
