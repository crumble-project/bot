import { CODING_TOOL_NAME, DESKTOP_TOOL_NAME } from "../contract/tools";

/** What the rest of the server knows of a job kind without its tools or prompts. */
export type JobKindFacts = {
  /** Names the kind's documents, tasks, request IDs, and message origin. Stored data depends on it: never rename. */
  kind: string;
  /** Names the job tool and the chat's extension that offers it. */
  toolName: string;
  /** Lowercase noun for tool output and reports, such as "coding job". */
  label: string;
  /** The extension a job of this kind selects: its own tools and hooks. */
  extension: string;
  /** Whether a bot may use the kind in a group turn. */
  inGroupTurns: boolean;
  /** One job works at a time: a message to a job waits while another job of this kind works. */
  exclusive?: boolean;
  /** Start and send take `owner_messages`, and the job keeps the owner messages it concerns with its tasks. */
  ownerRequest?: boolean;
};

export const JOB_KINDS = {
  coding: {
    kind: "coding",
    toolName: CODING_TOOL_NAME,
    label: "coding job",
    extension: "coding-job",
    inGroupTurns: false,
  },
  desktop: {
    kind: "desktop",
    toolName: DESKTOP_TOOL_NAME,
    label: "desktop job",
    extension: "desktop-job",
    inGroupTurns: false,
    exclusive: true,
    ownerRequest: true,
  },
} as const satisfies Record<string, JobKindFacts>;

export type JobKindName = keyof typeof JOB_KINDS;

/** The label as a sentence or a card starts it, such as "Coding job". */
export const jobKindTitle = ({ label }: Pick<JobKindFacts, "label">) =>
  `${label[0]!.toUpperCase()}${label.slice(1)}`;
