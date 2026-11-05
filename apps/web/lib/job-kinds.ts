import { IconDeviceDesktop, IconHammer } from "@tabler/icons-react";
import {
  CODING_TOOL_NAME,
  DESKTOP_TOOL_NAME,
} from "@crumble/server/contract/tools";

export const JOB_KINDS = {
  coding: { tool: CODING_TOOL_NAME, label: "Coding job", icon: IconHammer },
  desktop: {
    tool: DESKTOP_TOOL_NAME,
    label: "Desktop job",
    icon: IconDeviceDesktop,
  },
} as const;

export type JobKind = keyof typeof JOB_KINDS;

export type JobRef = { kind: JobKind; name: string };

/** Whether `origin` names a job kind: a message from a job reporting back. */
export const isJobKind = (origin: string | undefined): origin is JobKind =>
  origin !== undefined && Object.hasOwn(JOB_KINDS, origin);
