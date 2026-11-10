import { IconMessages, IconPhone } from "@tabler/icons-react";
import { siDiscord, type SimpleIcon } from "simple-icons";
import { BrandLogo } from "@/components/brand-logo";

const GATEWAYS = new Map<string, { label: string; icon: SimpleIcon }>([
  ["discord", { label: "Discord", icon: siDiscord }],
]);

const VOICE = "voice";

const gatewayLabel = (id: string) => GATEWAYS.get(id)?.label ?? id;

export const gatewayOrigin = (id: string) =>
  id === VOICE ? "Spoken on a call" : `Sent from ${gatewayLabel(id)}`;

export function GatewayIcon({ id }: { id: string }) {
  if (id === VOICE) return <IconPhone className="size-4" />;

  const icon = GATEWAYS.get(id)?.icon;

  return icon ? <BrandLogo icon={icon} /> : <IconMessages className="size-4" />;
}
