import { IconMessages } from "@tabler/icons-react";
import { siDiscord, type SimpleIcon } from "simple-icons";
import { BrandLogo } from "@/components/brand-logo";

const GATEWAYS = new Map<string, { label: string; icon: SimpleIcon }>([
  ["discord", { label: "Discord", icon: siDiscord }],
]);

export const gatewayLabel = (id: string) => GATEWAYS.get(id)?.label ?? id;

export function GatewayIcon({ id }: { id: string }) {
  const icon = GATEWAYS.get(id)?.icon;

  return icon ? <BrandLogo icon={icon} /> : <IconMessages className="size-4" />;
}
