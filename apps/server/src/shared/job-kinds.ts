export type JobKindFacts = {
  /** Names the kind's documents, tasks, request IDs, and message origin. Stored data depends on it: never rename. */
  kind: string;
  toolName: string;
  label: string;
  extension: string;
  /** One job works at a time: a message to a job waits while another job of this kind works. */
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
  `${label[0]!.toUpperCase()}${label.slice(1)}`;
