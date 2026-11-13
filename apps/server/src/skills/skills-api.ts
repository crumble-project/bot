import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import { mergedBody, type Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { skillInput, skillLifecycleInput } from "../contract/skills";
import { OwnerSkills } from "./owner-skills";
import { SkillInstaller } from "./skill-installer";
import { SkillRepository } from "./skill-repository";

type SkillRoutesOptions = {
  register: Register<Env, OwnerSkills | SkillInstaller | SkillRepository>;
  service: BotLookup;
};

const registerOwnSkillEditRoutes = ({
  register,
  service,
}: SkillRoutesOptions) => {
  register(
    routes.updateAgentSkill,
    function* (c) {
      const agentId = service.agent(c.req.param("id")).id;
      const ownerSkills = yield* OwnerSkills;

      const old = yield* ownerSkills.own(agentId, c.req.param("skillId"));

      const lifecycle = skillLifecycleInput.parse(
        yield* Effect.promise(() => c.req.json()),
      );

      const input = yield* Effect.promise(() => mergedBody(c, old, skillInput));

      return c.json(
        yield* ownerSkills.updateOwn(old.id, input, lifecycle),
        200,
      );
    },
    { parsesBody: true },
  );
  register(routes.deleteAgentSkill, function* (c) {
    const agentId = service.agent(c.req.param("id")).id;
    const ownerSkills = yield* OwnerSkills;
    const skills = yield* SkillRepository;

    const skill = yield* ownerSkills.own(agentId, c.req.param("skillId"));

    yield* skills.delete(skill.id);

    return c.body(null, 204);
  });
};

export const registerBotSkillRoutes = (options: SkillRoutesOptions) => {
  const { register, service } = options;

  register(routes.assignSkillBot, function* (c) {
    const { botId, assigned } = c.req.valid("json");
    const target = service.agent(botId);
    const ownerSkills = yield* OwnerSkills;

    return c.json(
      {
        skipped: yield* ownerSkills.assign(c.req.param("id"), target, assigned),
      },
      200,
    );
  });

  register(routes.agentSkills, function* (c) {
    const skills = yield* SkillRepository;

    return c.json(yield* skills.list(service.agent(c.req.param("id")).id), 200);
  });
  register(routes.createAgentSkill, function* (c) {
    const input = {
      ...c.req.valid("json"),
      agentId: service.agent(c.req.param("id")).id,
    };

    const skills = yield* SkillRepository;

    return c.json(yield* skills.create(input), 201);
  });
  registerOwnSkillEditRoutes(options);
};

const registerSharedSkillRoutes = ({ register }: SkillRoutesOptions) => {
  register(routes.skills, function* (c) {
    const ownerSkills = yield* OwnerSkills;

    return c.json(yield* ownerSkills.catalog, 200);
  });
  register(routes.getSkill, function* (c) {
    const ownerSkills = yield* OwnerSkills;

    return c.json(yield* ownerSkills.shared(c.req.param("id")), 200);
  });
  register(routes.createSkill, function* (c) {
    const input = c.req.valid("json");
    const skills = yield* SkillRepository;

    return c.json(yield* skills.create(input), 201);
  });
  register(
    routes.updateSkill,
    function* (c) {
      const ownerSkills = yield* OwnerSkills;
      const skills = yield* SkillRepository;
      const old = yield* ownerSkills.editable(c.req.param("id"));

      const input = yield* Effect.promise(() => mergedBody(c, old, skillInput));

      return c.json(yield* skills.update(old.id, input), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteSkill, function* (c) {
    const ownerSkills = yield* OwnerSkills;

    yield* ownerSkills.removeShared(c.req.param("id"));

    return c.body(null, 204);
  });
};

const registerSkillInstallRoutes = (options: SkillRoutesOptions) => {
  const { register, service } = options;

  register(routes.browseSkillRepository, function* (c) {
    const { location } = c.req.valid("json");
    const installer = yield* SkillInstaller;

    return c.json(yield* installer.browse(location), 200);
  });
  register(routes.installSkills, function* (c) {
    const { botIds, ...request } = c.req.valid("json");
    const bots = [...new Set(botIds)].map((botId) => service.agent(botId).id);
    const installer = yield* SkillInstaller;
    const ownerSkills = yield* OwnerSkills;

    const installed = yield* installer.install(request);

    yield* ownerSkills.shareWith(
      bots,
      installed.map((skill) => skill.id),
    );

    return c.json(installed, 201);
  });
  register(routes.checkSkillUpdates, function* (c) {
    const installer = yield* SkillInstaller;

    return c.json(yield* installer.check(), 200);
  });
  register(routes.pendingSkillUpdate, function* (c) {
    const installer = yield* SkillInstaller;

    return c.json(yield* installer.pending(c.req.param("id")), 200);
  });
  register(routes.applySkillUpdate, function* (c) {
    const installer = yield* SkillInstaller;

    return c.json(yield* installer.apply(c.req.param("id")), 200);
  });
};

export function registerSkillRoutes(options: SkillRoutesOptions) {
  registerSharedSkillRoutes(options);
  registerSkillInstallRoutes(options);
}
