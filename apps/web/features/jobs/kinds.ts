import {
  IconDeviceDesktop,
  IconHammer,
  type TablerIcon,
} from "@tabler/icons-react";
import {
  CODING_TOOL_NAME,
  DESKTOP_TOOL_NAME,
  type JobKind,
} from "@crumble/server/contract/tools";

type JobKindInfo = {
  tool: JobKind;
  label: string;
  icon: TablerIcon;
  onDesktop: boolean;
};

export const JOB_KINDS: Record<JobKind, JobKindInfo> = {
  coding: {
    tool: CODING_TOOL_NAME,
    label: "Coding job",
    icon: IconHammer,
    onDesktop: false,
  },
  desktop: {
    tool: DESKTOP_TOOL_NAME,
    label: "Desktop job",
    icon: IconDeviceDesktop,
    onDesktop: true,
  },
};
