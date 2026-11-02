import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  calculateCost,
  Type,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type Models,
  type TextContent,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  UsageDoc,
  type ConversationId,
  type Harness,
  type HookApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { z } from "zod";
import { SettingsRepository } from "../shared/settings-repository";

/** The account's vision model, as the owner chose it in Settings. */
export type VisionModelRef = { provider: string; model: string };

/** The setting that holds the vision model; absent means off. */
export const VISION_MODEL = "vision-model";

const stored = z
  .object({ provider: z.string(), model: z.string() })
  .optional()
  .catch(undefined);

/** The vision model a stored setting names; undefined means off. */
export const parseVisionModel = (
  value: JsonValue | undefined,
): VisionModelRef | undefined => stored.parse(value);

/** The vision model the owner chose; undefined means off. */
export const chosenVisionModel = SettingsRepository.use((r) =>
  r.get(VISION_MODEL),
).pipe(Effect.map(parseVisionModel));

export const VISION_EXTENSION = "vision";

export const ASK_ABOUT_IMAGE_TOOL_NAME = "ask_about_image";

/** Characters of an image's hash the bot sees as its id. */
const SHORT_ID_LENGTH = 8;

/** Entries read per page while looking for an image the bot asks about. */
const ENTRY_PAGE = 50;

const DESCRIBE_INSTRUCTIONS =
  "You describe images for an assistant that cannot see them. Describe what the image shows: its kind (photo, screenshot, document, chart, ...), subject, layout, people, objects, and anything the assistant would need to answer questions about it. Transcribe all visible text verbatim, in reading order, keeping numbers, names, and line breaks. Don't guess at what you can't see; say what is unreadable. Reply with the description only.";

const DESCRIBE_PROMPT = "Describe this image.";

const ASK_INSTRUCTIONS =
  "You answer an assistant's question about an image it cannot see. Answer from what the image shows, quoting visible text verbatim where it matters. Say so when the image doesn't show the answer. Reply with the answer only.";

/** Image descriptions by the vision model, keyed by the SHA-256 of the image's base64 data. */
export const VisionDescriptions = defineDoc<{
  descriptions: Record<string, string>;
}>({
  kind: "crumble.vision-descriptions",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork keeps the images it was forked with, so their descriptions stay good.
  fork: "current",
  initial: () => ({ descriptions: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 32,
});

/** Whether a model reads images itself; catalogs that list no modalities are trusted, as for chat uploads. */
export const readsImages = (model: { input?: readonly string[] } | undefined) =>
  !model?.input || model.input.includes("image");

/** The SHA-256 of an image's base64 data: its key in the description cache. */
export const imageHash = (data: string) =>
  createHash("sha256").update(data).digest("hex");

/** Whether the catalog says a model reads images; a vision model must, unlike a bot's model, which is trusted. */
const listsImages = (model: { input?: readonly string[] }) =>
  model.input?.includes("image") ?? false;

/** The chat models the account's keys reach that read images: the owner's choices of vision model. */
export const visionChoices = async (models: Models) =>
  (await models.getAvailable()).filter(listsImages);

/** The vision model `ref` names, when the catalog lists it and it reads images. */
export async function visionModelOf(
  models: Models,
  ref: VisionModelRef,
): Promise<Model<Api> | undefined> {
  // Dynamic catalogs (Melious) list models only after a refresh with the saved key.
  if (!models.getModel(ref.provider, ref.model))
    await models.refresh({ providers: [ref.provider] });
  const model = models.getModel(ref.provider, ref.model);

  return model && listsImages(model) ? model : undefined;
}

/** The call's usage, priced at the catalog's price when the provider left the cost out. */
function pricedUsage(model: Model<Api>, usage: Usage): Usage {
  if (usage.cost.total > 0 || model.cost.input <= 0) return usage;

  return {
    ...usage,
    cost: calculateCost(model, { ...usage, cost: { ...usage.cost } }),
  };
}

type Look = { text: string; usage: Usage } | { error: string; usage?: Usage };

const textOf = (reply: AssistantMessage) =>
  reply.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();

/** What a reply of the vision model says, priced; a failed or empty reply is an error that still spent. */
function lookOf(model: Model<Api>, reply: AssistantMessage): Look {
  const usage = pricedUsage(model, reply.usage);

  if (reply.stopReason === "error" || reply.stopReason === "aborted")
    return {
      error: reply.errorMessage ?? "the vision model gave no answer",
      usage,
    };

  const text = textOf(reply);

  return text
    ? { text, usage }
    : { error: "the vision model's answer was empty", usage };
}

/** One request to the vision model about one image; failures come back as an error with what they spent. */
async function look(
  models: Models,
  model: Model<Api>,
  image: ImageContent,
  ask: { instructions: string; prompt: string },
  context: Context,
): Promise<Look> {
  const signal = context.abortSignal;

  const request = {
    systemPrompt: ask.instructions,
    messages: [
      {
        role: "user" as const,
        content: [image, { type: "text" as const, text: ask.prompt }],
        timestamp: Date.now(),
      },
    ],
  };

  try {
    return lookOf(
      model,
      await models.completeSimple(model, request, signal ? { signal } : {}),
    );
  } catch (error) {
    if (signal?.aborted) throw error;

    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const spent = (usage: Usage | undefined): usage is Usage =>
  usage !== undefined && (usage.totalTokens > 0 || usage.cost.total > 0);

/** Adds `usage` to the model's bucket of the conversation's `pi.usage`, keyed `provider/modelId` as pi-durable keys it. */
async function recordModelUsage(
  tx: Tx,
  conversationId: ConversationId,
  model: Model<Api>,
  usage: Usage,
) {
  const totals = (await tx.doc(UsageDoc, conversationId)).models;
  const key = `${model.provider}/${model.id}`;
  const total = Object.hasOwn(totals, key) ? totals[key] : undefined;

  // Providers may leave optional counters undefined; documents take strict JSON.
  if (!total) {
    totals[key] = JSON.parse(JSON.stringify(usage));

    return;
  }

  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;

  if (usage.cacheWrite1h !== undefined)
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;

  if (usage.reasoning !== undefined)
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

const imagesOf = (message: Message): ImageContent[] =>
  (message.role === "user" || message.role === "toolResult") &&
  Array.isArray(message.content)
    ? message.content.flatMap((block) =>
        block.type === "image" ? [block] : [],
      )
    : [];

/** Whether the model of the conversation's next request reads images itself. */
async function botReadsImages(api: HookApi, context: Context) {
  const ref = (await api.snapshot(AgentDoc, api.conversationId, context))
    ?.model;

  return !ref || readsImages(api.models.getModel(ref.provider, ref.modelId));
}

const describedText = (hash: string, description: string) =>
  `<image id="${hash.slice(0, SHORT_ID_LENGTH)}" described-by="vision model">\n${description}\n</image>`;

const failedText = (reason: string) =>
  `[An image could not be read: ${reason}]`;

type VisionOptions = {
  /** The bot's harness; the hook and tool run only once it is open. */
  harness: () => Harness | undefined;
  /** The account's vision model, read at each use: the owner may change it at any time. */
  visionModel: () => VisionModelRef | undefined;
};

const failureMemo = (hash: string) => `vision-failed:${hash}`;

/** One request's view of the vision model: the conversation's hook API, and the model when the catalog has it. */
type Describer = {
  options: VisionOptions;
  chosen: VisionModelRef;
  model: Model<Api> | undefined;
  api: HookApi;
  context: Context;
};

/** Commits a description and what asking for it spent, so later requests and turns reuse it. */
async function remember(
  describer: Describer,
  model: Model<Api>,
  hash: string,
  result: Look,
) {
  const { api, context } = describer;
  const harness = describer.options.harness();

  if (!harness || (!("text" in result) && !spent(result.usage))) return;

  await harness.commit(async (tx) => {
    if ("text" in result)
      (await tx.doc(VisionDescriptions, api.conversationId)).descriptions[
        hash
      ] = result.text;

    if (spent(result.usage))
      await recordModelUsage(tx, api.conversationId, model, result.usage);
  }, context);
}

/**
 * What stands in for one image the conversation has no description of. A failure is remembered for this generation
 * only, so its retries don't ask again, and the next turn does.
 */
async function describeOne(
  describer: Describer,
  hash: string,
  image: ImageContent,
) {
  const { api, context, model, chosen } = describer;
  const failed = await api.memo<string>(failureMemo(hash), context);

  if (failed !== undefined) return failedText(failed);

  if (!model)
    return failedText(
      await api.memo(
        failureMemo(hash),
        `the vision model ${chosen.provider}/${chosen.model} isn't available`,
        context,
      ),
    );

  const result = await look(
    api.models,
    model,
    image,
    { instructions: DESCRIBE_INSTRUCTIONS, prompt: DESCRIBE_PROMPT },
    context,
  );

  await remember(describer, model, hash, result);

  if ("text" in result) return describedText(hash, result.text);

  return failedText(await api.memo(failureMemo(hash), result.error, context));
}

/** What stands in for each image of one request, by hash: a cached description, a new one, or a failure note. */
async function standinsFor(
  options: VisionOptions,
  chosen: VisionModelRef,
  images: Map<string, ImageContent>,
  api: HookApi,
  context: Context,
) {
  const cached =
    (await api.snapshot(VisionDescriptions, api.conversationId, context))
      ?.descriptions ?? {};

  const missing = [...images].filter(([hash]) => !Object.hasOwn(cached, hash));

  const describer: Describer = {
    options,
    chosen,
    model: missing.length ? await visionModelOf(api.models, chosen) : undefined,
    api,
    context,
  };

  return new Map<string, string>([
    ...Object.entries(cached).map(
      ([hash, text]) => [hash, describedText(hash, text)] as const,
    ),
    ...(await Promise.all(
      missing.map(
        async ([hash, image]) =>
          [hash, await describeOne(describer, hash, image)] as const,
      ),
    )),
  ]);
}

/** `message` with each image replaced by what stands in for it. */
function replaced(
  message: Message,
  hashes: Map<ImageContent, string>,
  standins: Map<string, string>,
): Message {
  // Every image of the request has a hash and a stand-in: both were made from these messages.
  const swap = (block: TextContent | ImageContent): TextContent =>
    block.type === "image"
      ? { type: "text", text: standins.get(hashes.get(block)!)! }
      : block;

  if (!imagesOf(message).length) return message;

  if (message.role === "toolResult")
    return { ...message, content: message.content.map(swap) };

  if (message.role === "user" && Array.isArray(message.content))
    return { ...message, content: message.content.map(swap) };

  return message;
}

/** Stands descriptions in for a request's images while a vision model is set and the request's model can't read them. */
function describeHook(options: VisionOptions) {
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const chosen = options.visionModel();

      if (!chosen || !messages.some((message) => imagesOf(message).length))
        return undefined;

      if (await botReadsImages(api, context)) return undefined;

      const hashes = new Map(
        messages
          .flatMap(imagesOf)
          .map((image) => [image, imageHash(image.data)] as const),
      );

      const images = new Map(
        [...hashes].map(([image, hash]) => [hash, image] as const),
      );

      const standins = await standinsFor(options, chosen, images, api, context);

      return {
        messages: messages.map((message) =>
          replaced(message, hashes, standins),
        ),
      };
    },
  });
}

/** The image block of the conversation's stored entries whose hash starts with `id`, newest first. */
async function findImage(
  harness: Harness,
  conversationId: ConversationId,
  id: string,
  context: Context,
) {
  const conversation = await harness.conversation(conversationId, context);
  let cursor: Parameters<NonNullable<typeof conversation>["entries"]>[2];

  if (!conversation) return undefined;

  do {
    const page = await conversation.entries(
      { order: "descending" },
      ENTRY_PAGE,
      cursor,
      context,
    );

    const image = page.items
      .flatMap((entry) => (entry.model ?? []).flatMap(imagesOf))
      .find((block) => imageHash(block.data).startsWith(id));

    if (image) return image;
    cursor = page.next;
  } while (cursor !== undefined);

  return undefined;
}

/** The vision model and the image the bot asks about; throws what the bot should hear when either is missing. */
async function askTarget(
  options: VisionOptions,
  models: Models,
  conversationId: ConversationId,
  id: string,
  context: Context,
) {
  const chosen = options.visionModel();
  const harness = options.harness();

  if (!chosen || !harness)
    throw new Error(
      "The account has no vision model; the owner turned it off in Settings.",
    );

  const model = await visionModelOf(models, chosen);

  if (!model)
    throw new Error(
      `The vision model ${chosen.provider}/${chosen.model} isn't available.`,
    );

  const image = await findImage(harness, conversationId, id, context);

  if (!image)
    throw new Error(`No image with id ${id} is in this conversation.`);

  return { model, image };
}

/** Lets the bot ask the vision model a question about an image it received as a description. */
function askTool(options: VisionOptions) {
  return defineTool({
    name: ASK_ABOUT_IMAGE_TOOL_NAME,
    description:
      "Ask the account's vision model a question about an image in this conversation that you received as a description, such as <image id=\"ab12cd34\">. Use it for details the description leaves out, like the total on a receipt or the text in one corner. Pass the image's id and one specific question.",
    parameters: Type.Object({
      image: Type.String({
        minLength: SHORT_ID_LENGTH,
        maxLength: 64,
        description: 'The image\'s id, as in <image id="...">.',
      }),
      question: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    // Only reads: a rerun asks again.
    replay: "safe",
    execute: async (args, api, context) => {
      const { model, image } = await askTarget(
        options,
        api.models,
        api.conversationId,
        args.image.trim().toLowerCase(),
        context,
      );

      const result = await look(
        api.models,
        model,
        image,
        { instructions: ASK_INSTRUCTIONS, prompt: args.question },
        context,
      );

      const usage = spent(result.usage) ? { usage: result.usage } : {};

      if ("error" in result)
        return {
          output: [{ type: "text" as const, text: failedText(result.error) }],
          isError: true,
          ...usage,
        };

      return {
        output: [{ type: "text" as const, text: result.text }],
        ...usage,
      };
    },
  });
}

/**
 * The vision extension. Its generation hook stands a description in for every image of a request whose model can't read
 * images, while the account has a vision model; the stored transcript keeps the image. `ask_about_image` lets the bot
 * ask the vision model about one of those images; the runtime offers it only where the hook describes.
 */
export function visionExtension(options: VisionOptions) {
  const ask = askTool(options);

  return {
    extension: defineExtension({
      name: VISION_EXTENSION,
      tools: [ask],
      hooks: [describeHook(options)],
    }),
    ask,
  };
}
