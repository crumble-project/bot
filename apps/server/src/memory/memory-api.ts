import { Effect } from "effect";
import type { Env } from "hono";
import type { z } from "zod";
import { routes, type memoryInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { NotFound } from "../shared/errors";
import { MemoryRepository } from "./memory-repository";

type MemoryRoutesOptions = {
  register: Register<Env, MemoryRepository>;
  service: BotLookup;
};

const memoryOf = Effect.fnUntraced(function* (
  agentId: string | null,
  memoryId: string,
) {
  const memories = yield* MemoryRepository;
  const memory = yield* memories.get(memoryId);

  if (!memory || memory.agentId !== agentId)
    return yield* Effect.fail(new NotFound({ message: "Memory not found" }));

  return memory;
});

const createMemory = (
  agentId: string | null,
  input: z.output<typeof memoryInput>,
) =>
  MemoryRepository.use((r) =>
    r.create({ agentId, content: input.content, source: { kind: "owner" } }),
  );

const updateMemory = (memoryId: string, input: z.output<typeof memoryInput>) =>
  MemoryRepository.use((r) => r.update(memoryId, input));

const deleteMemory = (memoryId: string) =>
  MemoryRepository.use((r) => r.delete(memoryId));

const registerBotMemoryRoutes = (options: MemoryRoutesOptions) => {
  const { register, service } = options;

  register(routes.agentMemories, function* (c) {
    service.agent(c.req.param("id"));
    const memories = yield* MemoryRepository;

    return c.json(yield* memories.list(c.req.param("id")), 200);
  });
  register(routes.createAgentMemory, function* (c) {
    service.agent(c.req.param("id"));

    return c.json(
      yield* createMemory(c.req.param("id"), c.req.valid("json")),
      201,
    );
  });
  register(routes.updateAgentMemory, function* (c) {
    const memory = yield* memoryOf(c.req.param("id"), c.req.param("memoryId"));

    return c.json(yield* updateMemory(memory.id, c.req.valid("json")), 200);
  });
  register(routes.deleteAgentMemory, function* (c) {
    const memory = yield* memoryOf(c.req.param("id"), c.req.param("memoryId"));

    yield* deleteMemory(memory.id);

    return c.body(null, 204);
  });
};

const registerSharedMemoryRoutes = (options: MemoryRoutesOptions) => {
  const { register } = options;

  register(routes.memories, function* (c) {
    const memories = yield* MemoryRepository;

    return c.json(yield* memories.list(null), 200);
  });
  register(routes.createMemory, function* (c) {
    return c.json(yield* createMemory(null, c.req.valid("json")), 201);
  });
  register(routes.updateMemory, function* (c) {
    const memory = yield* memoryOf(null, c.req.param("id"));

    return c.json(yield* updateMemory(memory.id, c.req.valid("json")), 200);
  });
  register(routes.deleteMemory, function* (c) {
    const memory = yield* memoryOf(null, c.req.param("id"));

    yield* deleteMemory(memory.id);

    return c.body(null, 204);
  });
};

export function registerMemoryRoutes(options: MemoryRoutesOptions) {
  registerBotMemoryRoutes(options);
  registerSharedMemoryRoutes(options);
}
