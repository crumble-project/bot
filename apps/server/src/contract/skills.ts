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

export const skillLifecycleInput = z.object({
  state: z.enum(SKILL_STATES).optional(),
  pinned: z.boolean().optional(),
});

export type SkillOrigin = {
  repository: string;
  branch: string;
  path: string;
  commit: string;
  digest: string;
};

export type Skill = SkillInput & {
  copiedFromSkillId?: string | null;
  origin: SkillOrigin | null;
  id: string;
  agentId: string | null;
  createdBy: "owner" | "bot";
  sourceExecutionId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  state: SkillState;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LearnedChange = {
  id: string;
  agentId: string | null;
  actor: ChangeActor;
  target: (typeof CHANGE_TARGETS)[number];
  targetId: string;
  action: (typeof CHANGE_ACTIONS)[number];
  before: Skill | Memory | null;
  after: Skill | Memory | null;
  source: ChangeSource | null;
  revertsId: string | null;
  createdAt: string;
};
