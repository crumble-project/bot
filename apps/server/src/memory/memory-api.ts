import type { z } from "zod";
import { memoryInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { CoreServices } from "../shared/core-layer";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { MemoryRepository } from "./memory-repository";

type Exec = Runner<CoreServices>["runSync"];

type MemoryRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the memory routes read and write. */
  run: Runner<CoreServices>;
};

/** The memory, which must belong to the bot or, with `null`, to every bot. */
const memoryOf = (exec: Exec, agentId: string | null, memoryId: string) => {
  const memory = exec(MemoryRepository.use((r) => r.get(memoryId)));

  if (!memory || memory.agentId !== agentId)
    throw new NotFound({ message: "Memory not found" });

  return memory;
};

const createMemory = (
  exec: Exec,
  agentId: string | null,
  input: z.output<typeof memoryInput>,
) =>
  exec(
    MemoryRepository.use((r) =>
      r.create({ agentId, content: input.content, source: { kind: "owner" } }),
    ),
  );

const updateMemory = (
  exec: Exec,
  memoryId: string,
  input: z.output<typeof memoryInput>,
) => exec(MemoryRepository.use((r) => r.update(memoryId, input)));

const deleteMemory = (exec: Exec, memoryId: string) =>
  exec(MemoryRepository.use((r) => r.delete(memoryId)));

/** The memories a bot remembers for itself alone. */
const registerBotMemoryRoutes = (options: MemoryRoutesOptions) => {
  const { register, service } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.agentMemories, (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      exec(MemoryRepository.use((r) => r.list(c.req.param("id")))),
      200,
    );
  });
  register(routes.createAgentMemory, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      createMemory(
        exec,
        c.req.param("id"),
        memoryInput.parse(await c.req.json()),
      ),
      201,
    );
  });
  register(routes.updateAgentMemory, async (c) => {
    const memory = memoryOf(exec, c.req.param("id"), c.req.param("memoryId"));

    return c.json(
      updateMemory(exec, memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteAgentMemory, (c) => {
    deleteMemory(
      exec,
      memoryOf(exec, c.req.param("id"), c.req.param("memoryId")).id,
    );

    return c.body(null, 204);
  });
};

/** The memories every bot may read. */
const registerSharedMemoryRoutes = (options: MemoryRoutesOptions) => {
  const { register } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.memories, (c) =>
    c.json(exec(MemoryRepository.use((r) => r.list(null))), 200),
  );
  register(routes.createMemory, async (c) =>
    c.json(
      createMemory(exec, null, memoryInput.parse(await c.req.json())),
      201,
    ),
  );
  register(routes.updateMemory, async (c) => {
    const memory = memoryOf(exec, null, c.req.param("id"));

    return c.json(
      updateMemory(exec, memory.id, memoryInput.parse(await c.req.json())),
      200,
    );
  });
  register(routes.deleteMemory, (c) => {
    deleteMemory(exec, memoryOf(exec, null, c.req.param("id")).id);

    return c.body(null, 204);
  });
};

/** The memory routes, in the order the contract document lists them. */
export function registerMemoryRoutes(options: MemoryRoutesOptions) {
  registerBotMemoryRoutes(options);
  registerSharedMemoryRoutes(options);
}
