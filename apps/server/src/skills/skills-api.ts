import { routes, changesInput, reviewsInput } from "../contract/api-contract";
import {
  skillInstallInput,
  skillLocationInput,
} from "../contract/skill-install";
import type { Register } from "../contract/route";
import { AgentRepository } from "../bots/agent-repository";
import type { BotsAccess } from "../bots/bots";
import { skillInput, skillLifecycleInput } from "../shared/domain";
import { NotFound, ReadOnly } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { ChangeReverter } from "./change-reverter";
import type { CommonSkill } from "./common-skills";
import { LearnedChangeRepository } from "./learned-change-repository";
import { SkillInstaller } from "./skill-installer";
import { SkillRepository } from "./skill-repository";

type Services =
  | AgentRepository
  | ChangeReverter
  | LearnedChangeRepository
  | SkillInstaller
  | SkillRepository;

type Exec = Runner<Services>["runSync"];

type SkillRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the skill routes read and write. */
  run: Runner<Services>;
  /** Skills the server ships with; they are read-only. */
  commonSkills?: CommonSkill[] | undefined;
};

/** The bot's own skill, which must belong to that bot. */
const agentSkill = (exec: Exec, agentId: string, skillId: string) => {
  const skill = exec(SkillRepository.use((r) => r.get(skillId)));

  if (!skill || skill.agentId !== agentId)
    throw new NotFound({ message: "Skill not found" });

  return skill;
};

const isCommonSkill = (
  commonSkills: CommonSkill[] | undefined,
  skillId: string,
) => Boolean(commonSkills?.some((skill) => skill.id === skillId));

/** Deletes a shared skill and drops it from the bots that had it shared. */
const removeSharedSkill = (exec: Exec, skillId: string) => {
  const skill = exec(SkillRepository.use((r) => r.get(skillId)));

  if (skill?.agentId || !exec(SkillRepository.use((r) => r.delete(skillId))))
    throw new NotFound({ message: "Skill not found" });

  for (const agent of exec(AgentRepository.use((r) => r.list))) {
    const shared = agent.sharedSkills ?? [];

    if (shared.includes(skillId))
      exec(
        AgentRepository.use((r) =>
          r.update(agent.id, {
            sharedSkills: shared.filter((id) => id !== skillId),
          }),
        ),
      );
  }
};

/** The skills one bot owns. */
const registerBotSkillRoutes = (options: SkillRoutesOptions) => {
  const { register, service } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.agentSkills, (c) =>
    c.json(
      exec(
        SkillRepository.use((r) => r.list(service.agent(c.req.param("id")).id)),
      ),
      200,
    ),
  );
  register(routes.createAgentSkill, async (c) => {
    const input = {
      ...skillInput.parse(await c.req.json()),
      agentId: service.agent(c.req.param("id")).id,
    };

    return c.json(exec(SkillRepository.use((r) => r.create(input))), 201);
  });
  register(routes.updateAgentSkill, async (c) => {
    const agentId = service.agent(c.req.param("id")).id;
    const old = agentSkill(exec, agentId, c.req.param("skillId"));

    const body = await c.req.json();
    const lifecycle = skillLifecycleInput.parse(body);

    return c.json(
      exec(
        SkillRepository.use((r) =>
          r.update(old.id, {
            ...skillInput.parse({ ...old, ...body }),
            ...(lifecycle.state && { state: lifecycle.state }),
            ...(lifecycle.pinned !== undefined && { pinned: lifecycle.pinned }),
          }),
        ),
      ),
      200,
    );
  });
  register(routes.deleteAgentSkill, (c) => {
    const agentId = service.agent(c.req.param("id")).id;
    const skill = agentSkill(exec, agentId, c.req.param("skillId"));

    exec(SkillRepository.use((r) => r.delete(skill.id)));

    return c.body(null, 204);
  });
};

/** The learned changes the bot's reviews produced, and the owner reverting one. */
const registerSkillReviewRoutes = (options: SkillRoutesOptions) => {
  const { register, service } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.agentReviews, (c) =>
    c.json(
      exec(
        LearnedChangeRepository.use((r) =>
          r.listReviewResults(
            service.agent(c.req.param("id")).id,
            reviewsInput.parse(c.req.query()).limit,
          ),
        ),
      ),
      200,
    ),
  );
  register(routes.changes, (c) => {
    const query = changesInput.parse(c.req.query());

    if (query.agentId && query.agentId !== "shared")
      service.agent(query.agentId);

    return c.json(
      exec(
        LearnedChangeRepository.use((r) =>
          r.list(query.agentId === "shared" ? null : query.agentId, {
            limit: query.limit,
            before: query.before,
          }),
        ),
      ),
      200,
    );
  });
  register(routes.revertChange, (c) => {
    const reverted = exec(
      ChangeReverter.use((r) =>
        r.revert(c.req.param("id"), { actor: "owner" }),
      ),
    );

    if (!reverted) throw new NotFound({ message: "Change not found" });

    return c.json(reverted, 201);
  });
};

/** Every skill a bot may use: the bundled ones the server ships and the shared ones the owner added. */
const skillCatalog = (exec: Exec, commonSkills: CommonSkill[] | undefined) => [
  ...(commonSkills ?? []).map(
    ({ id, name, description, instructions, documents, path }) => ({
      id,
      name,
      description,
      instructions,
      documents,
      path,
      source: "bundled" as const,
    }),
  ),
  ...sharedWithUpdates(exec),
];

const sharedWithUpdates = (exec: Exec) => {
  const updates = exec(SkillInstaller.use((r) => r.updates));

  return exec(SkillRepository.use((r) => r.list(null))).map((skill) => ({
    ...skill,
    update: updates.get(skill.id) ?? null,
    source: "shared" as const,
  }));
};

/** The shared skills every bot may use, including the bundled ones the server ships with. */
const registerSharedSkillRoutes = (options: SkillRoutesOptions) => {
  const { register, commonSkills } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.skills, (c) => c.json(skillCatalog(exec, commonSkills), 200));
  register(routes.getSkill, (c) => {
    const skill = exec(SkillRepository.use((r) => r.get(c.req.param("id"))));

    if (!skill || skill.agentId)
      throw new NotFound({ message: "Skill not found" });

    return c.json(skill, 200);
  });
  register(routes.createSkill, async (c) => {
    const input = skillInput.parse(await c.req.json());

    return c.json(exec(SkillRepository.use((r) => r.create(input))), 201);
  });
  register(routes.updateSkill, async (c) => {
    if (isCommonSkill(commonSkills, c.req.param("id")))
      throw new ReadOnly({ message: "Bundled skills are read-only" });

    const old = exec(SkillRepository.use((r) => r.get(c.req.param("id"))));

    if (!old || old.agentId) throw new NotFound({ message: "Skill not found" });

    if (old.origin)
      throw new ReadOnly({
        message: "Installed skills are read-only. Make a copy to change one.",
      });

    const input = skillInput.parse({ ...old, ...(await c.req.json()) });

    return c.json(
      exec(SkillRepository.use((r) => r.update(old.id, input))),
      200,
    );
  });
  register(routes.deleteSkill, (c) => {
    const skillId = c.req.param("id");

    if (isCommonSkill(commonSkills, skillId))
      throw new ReadOnly({ message: "Bundled skills are read-only" });

    removeSharedSkill(exec, skillId);

    return c.body(null, 204);
  });
};

/** Adds `skillIds` to each bot's shared skills. */
const shareWith = (exec: Exec, botIds: string[], skillIds: string[]) => {
  for (const botId of botIds) {
    const agent = exec(AgentRepository.use((r) => r.get(botId)));

    if (agent)
      exec(
        AgentRepository.use((r) =>
          r.update(agent.id, {
            sharedSkills: [
              ...new Set([...(agent.sharedSkills ?? []), ...skillIds]),
            ].toSorted(),
          }),
        ),
      );
  }
};

/** Installing shared skills from GitHub and updating them from upstream. */
const registerSkillInstallRoutes = (options: SkillRoutesOptions) => {
  const { register, service, run } = options;
  const exec: Exec = (effect) => run.runSync(effect);

  register(routes.browseSkillRepository, async (c) => {
    const { location } = skillLocationInput.parse(await c.req.json());

    return c.json(
      await run.runPromise(SkillInstaller.use((r) => r.browse(location))),
      200,
    );
  });
  register(routes.installSkills, async (c) => {
    const { botIds, ...request } = skillInstallInput.parse(await c.req.json());
    const bots = [...new Set(botIds)].map((botId) => service.agent(botId).id);

    const installed = await run.runPromise(
      SkillInstaller.use((r) => r.install(request)),
    );

    shareWith(
      exec,
      bots,
      installed.map((skill) => skill.id),
    );

    return c.json(installed, 201);
  });
  register(routes.checkSkillUpdates, async (c) =>
    c.json(await run.runPromise(SkillInstaller.use((r) => r.check())), 200),
  );
  register(routes.pendingSkillUpdate, async (c) =>
    c.json(
      await run.runPromise(
        SkillInstaller.use((r) => r.pending(c.req.param("id"))),
      ),
      200,
    ),
  );
  register(routes.applySkillUpdate, async (c) =>
    c.json(
      await run.runPromise(
        SkillInstaller.use((r) => r.apply(c.req.param("id"))),
      ),
      200,
    ),
  );
};

/** The skill routes, in the order the contract document lists them. */
export function registerSkillRoutes(options: SkillRoutesOptions) {
  registerBotSkillRoutes(options);
  registerSkillReviewRoutes(options);
  registerSharedSkillRoutes(options);
  registerSkillInstallRoutes(options);
}
