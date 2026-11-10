import { queryOptions } from "@tanstack/react-query";
import type {
  VoiceGatewayConfig,
  VoiceGatewayDescription,
} from "@crumble/server/contract/voice-gateway";
import { api } from "@/lib/api";

export type { VoiceGatewayConfig };

export type VoiceGateway = VoiceGatewayDescription;

export const voiceGatewayQuery = queryOptions({
  queryKey: ["voice-gateway"],
  queryFn: ({ signal }) => api<"voiceGateway">("/v1/voice-gateway", { signal }),
  refetchInterval: 5000,
});
