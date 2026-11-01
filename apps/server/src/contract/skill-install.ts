import { z } from "@hono/zod-openapi";
import { skillDocumentResponse } from "./api-responses";

export const skillLocationInput = z
  .object({
    /** `owner/repo` or a github.com URL; a `/tree/<branch>/<folder>` URL narrows the search. */
    location: z.string().trim().min(1).max(2000),
  })
  .strict();

export const skillInstallInput = z
  .object({
    repository: z.string().min(1).max(200),
    branch: z.string().min(1).max(255),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "A full commit SHA"),
    paths: z.array(z.string().max(1000)).min(1).max(100),
    /** Bots that start using the installed skills. */
    botIds: z.array(z.string().min(1)).max(200).default([]),
  })
  .strict();

export const skillCandidateResponse = z
  .object({
    path: z
      .string()
      .openapi({ description: "The skill's folder; empty for the root." }),
    name: z.string(),
    description: z.string(),
    status: z.enum(["new", "installed", "update", "clash", "invalid"]),
    problem: z.string().nullable().openapi({
      description: "Why a `clash` or `invalid` skill can't be installed.",
    }),
    skipped: z.array(z.string()).openapi({
      description:
        "Files in the folder that won't be imported: only SKILL.md and references/*.md are.",
    }),
    skillId: z.string().nullable().openapi({
      description: "The installed skill, for `installed` and `update`.",
    }),
  })
  .openapi("SkillCandidate");

export const skillListingResponse = z
  .object({
    repository: z.string(),
    branch: z.string(),
    commit: z.string(),
    path: z.string(),
    skills: z.array(skillCandidateResponse),
    omitted: z
      .number()
      .int()
      .openapi({ description: "Skills beyond the first hundred, not listed." }),
  })
  .openapi("SkillListing");

export const pendingSkillUpdateResponse = z
  .object({
    commit: z.string(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    documents: z.array(skillDocumentResponse),
    skipped: z.array(z.string()),
  })
  .openapi("PendingSkillUpdate");

export const skillCheckResponse = z
  .object({
    failed: z.array(
      z.object({
        repository: z.string(),
        branch: z.string(),
        message: z.string(),
      }),
    ),
  })
  .openapi("SkillCheck");
