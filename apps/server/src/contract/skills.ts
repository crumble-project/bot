import { z } from "zod";
import type {
  CHANGE_ACTIONS,
  CHANGE_TARGETS,
  ChangeActor,
  ChangeSource,
  Memory,
} from "../shared/domain";
import {
  MAX_INSTRUCTIONS_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_DOCUMENTS,
  MAX_SKILL_DOCUMENT_CHARS,
  MAX_SKILL_NAME_CHARS,
} from "../shared/limits";

/** A reference document inside a skill package, loaded only when the bot asks for it. */
export const skillDocumentInput = z.object({
  path: z
    .string()
    .regex(
      /^references\/[a-z0-9][a-z0-9._-]{0,99}\.md$/,
      "Document paths look like references/topic.md",
    ),
  content: z.string().min(1).max(MAX_SKILL_DOCUMENT_CHARS),
});

export const skillInput = z.object({
  name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS),
  description: z.string().trim().max(MAX_SKILL_DESCRIPTION_CHARS).default(""),
  instructions: z.string().max(MAX_INSTRUCTIONS_CHARS),
  documents: z
    .array(skillDocumentInput)
    .max(MAX_SKILL_DOCUMENTS)
    .default([])
    .refine(
      (documents) =>
        new Set(documents.map((document) => document.path)).size ===
        documents.length,
      "Document paths must be unique",
    ),
});

export type SkillInput = z.infer<typeof skillInput>;

export const SKILL_STATES = ["active", "stale", "archived"] as const;

type SkillState = (typeof SKILL_STATES)[number];

/** What the owner may change on a skill beyond its content: its lifecycle state and whether the curator leaves it alone. */
export const skillLifecycleInput = z.object({
  state: z.enum(SKILL_STATES).optional(),
  pinned: z.boolean().optional(),
});

/** Where an installed skill came from: a folder in a public GitHub repository, at one commit of a branch. */
export type SkillOrigin = {
  /** `owner/repo`. */
  repository: string;
  branch: string;
  /** The skill's folder in the repository; empty for the root. */
  path: string;
  commit: string;
  /** Fingerprint of the imported files, so a commit that changes nothing else doesn't count as an update. */
  digest: string;
};

/** A skill package in the library: a bot's own when `agentId` is set, shared when null. */
export type Skill = SkillInput & {
  /** Direct source of an owner-assigned copy; retained if the source is deleted. */
  copiedFromSkillId?: string | null;
  /** Set for a skill installed from GitHub, which nobody can edit. */
  origin: SkillOrigin | null;
  id: string;
  agentId: string | null;
  /** Who wrote the skill first; a bot's skills carry the execution they were learned from. */
  createdBy: "owner" | "bot";
  sourceExecutionId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  state: SkillState;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One recorded change to a skill or memory, with the state before and after, so the owner can undo it. */
export type LearnedChange = {
  id: string;
  /** The bot whose skill or memory changed; null for a shared one. */
  agentId: string | null;
  actor: ChangeActor;
  target: (typeof CHANGE_TARGETS)[number];
  targetId: string;
  action: (typeof CHANGE_ACTIONS)[number];
  before: Skill | Memory | null;
  after: Skill | Memory | null;
  source: ChangeSource | null;
  /** The change this one undid. */
  revertsId: string | null;
  createdAt: string;
};
