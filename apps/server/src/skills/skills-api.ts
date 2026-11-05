import { routes } from "../contract/api-contract";
import { mergedBody, type Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { skillInput, skillLifecycleInput } from "../contract/skills";
import type { Runner } from "../shared/runner";
import { OwnerSkills } from "./owner-skills";
import { SkillInstaller } from "./skill-installer";
import { SkillRepository } from "./skill-repository";

type Services = OwnerSkills | SkillInstaller | SkillRepository;

type SkillRoutesOptions = {
  register: Register;
  service: BotLookup;
  run: Runner<Services>;
};

export const registerBotSkillRoutes = (options: SkillRoutesOptions) => {
  const { register, service, run } = options;

  register(routes.assignSkillBot, async (c) => {
    const { botId, assigned } = c.req.valid("json");
    const target = service.agent(botId);

    return c.json(
      {
        skipped: await run.runPromise(
          OwnerSkills.use((s) => s.assign(c.req.param("id"), target, assigned)),
        ),
      },
      200,
    );
  });

  register(routes.agentSkills, (c) =>
    c.json(
      run.runSync(
        SkillRepository.use((r) => r.list(service.agent(c.req.param("id")).id)),
      ),
      200,
    ),
  );
  register(routes.createAgentSkill, async (c) => {
    const input = {
      ...c.req.valid("json"),
      agentId: service.agent(c.req.param("id")).id,
    };

    return c.json(
      run.runSync(SkillRepository.use((r) => r.create(input))),
      201,
    );
  });
  register(
    routes.updateAgentSkill,
    async (c) => {
      const agentId = service.agent(c.req.param("id")).id;

      const old = await run.runPromise(
        OwnerSkills.use((s) => s.own(agentId, c.req.param("skillId"))),
      );

      const lifecycle = skillLifecycleInput.parse(await c.req.json());
      const input = await mergedBody(c, old, skillInput);

      return c.json(
        await run.runPromise(
          OwnerSkills.use((s) => s.updateOwn(old.id, input, lifecycle)),
        ),
        200,
      );
    },
    { parsesBody: true },
  );
  register(routes.deleteAgentSkill, async (c) => {
    const agentId = service.agent(c.req.param("id")).id;

    const skill = await run.runPromise(
      OwnerSkills.use((s) => s.own(agentId, c.req.param("skillId"))),
    );

    run.runSync(SkillRepository.use((r) => r.delete(skill.id)));

    return c.body(null, 204);
  });
};

const registerSharedSkillRoutes = ({ register, run }: SkillRoutesOptions) => {
  register(routes.skills, async (c) =>
    c.json(await run.runPromise(OwnerSkills.use((s) => s.catalog)), 200),
  );
  register(routes.getSkill, async (c) =>
    c.json(
      await run.runPromise(OwnerSkills.use((s) => s.shared(c.req.param("id")))),
      200,
    ),
  );
  register(routes.createSkill, (c) => {
    const input = c.req.valid("json");

    return c.json(
      run.runSync(SkillRepository.use((r) => r.create(input))),
      201,
    );
  });
  register(
    routes.updateSkill,
    async (c) => {
      const old = await run.runPromise(
        OwnerSkills.use((s) => s.editable(c.req.param("id"))),
      );

      const input = await mergedBody(c, old, skillInput);

      return c.json(
        run.runSync(SkillRepository.use((r) => r.update(old.id, input))),
        200,
      );
    },
    { parsesBody: true },
  );
  register(routes.deleteSkill, async (c) => {
    await run.runPromise(
      OwnerSkills.use((s) => s.removeShared(c.req.param("id"))),
    );

    return c.body(null, 204);
  });
};

const registerSkillInstallRoutes = (options: SkillRoutesOptions) => {
  const { register, service, run } = options;

  register(routes.browseSkillRepository, async (c) => {
    const { location } = c.req.valid("json");

    return c.json(
      await run.runPromise(SkillInstaller.use((r) => r.browse(location))),
      200,
    );
  });
  register(routes.installSkills, async (c) => {
    const { botIds, ...request } = c.req.valid("json");
    const bots = [...new Set(botIds)].map((botId) => service.agent(botId).id);

    const installed = await run.runPromise(
      SkillInstaller.use((r) => r.install(request)),
    );

    await run.runPromise(
      OwnerSkills.use((s) =>
        s.shareWith(
          bots,
          installed.map((skill) => skill.id),
        ),
      ),
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

export function registerSkillRoutes(options: SkillRoutesOptions) {
  registerSharedSkillRoutes(options);
  registerSkillInstallRoutes(options);
}
