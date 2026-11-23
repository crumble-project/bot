export type JobKindFacts = {
  kind: string;
  toolName: string;
  label: string;
  extension: string;

  exclusive?: boolean;
  ownerRequest?: boolean;
};

export const JOB_KINDS = {
  coding: {
    kind: "coding",
    toolName: "coding",
    label: "coding job",
    extension: "coding-job",
  },
  desktop: {
    kind: "desktop",
    toolName: "desktop",
    label: "desktop job",
    extension: "desktop-job",
    exclusive: true,
    ownerRequest: true,
  },
} as const satisfies Record<string, JobKindFacts>;

export type JobKindName = keyof typeof JOB_KINDS;

export const jobKindTitle = ({ label }: Pick<JobKindFacts, "label">) =>
  `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
