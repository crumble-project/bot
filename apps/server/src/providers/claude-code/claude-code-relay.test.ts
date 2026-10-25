// Ported from Hermes' claude-subscription-directsdk tests/test_admission_*.py (MIT, see THIRD_PARTY_NOTICES.md).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Admission,
  Capture,
  dropMessageBreakpoints,
  pinMessageBreakpoint,
  QueriedTurnMismatch,
  restoreQueriedTurn,
  stableRequestContext,
  streamToolInput,
  type Block,
} from "./relay";

type Mark = NonNullable<Block["cache_control"]>;

type Message = { role: string; content: string | Block[] };

type Tool = {
  name: string;
  description?: string;
  input_schema: { type: string };
  cache_control?: Mark;
  eager_input_streaming?: boolean;
};

type Body = {
  model?: string;
  messages: Message[];
  system?: Block[];
  tools?: Tool[];
  cache_control?: Mark;
};

type At = [number, number];

const parse = (payload: string): Body => JSON.parse(payload);

const list = (content: string | Block[] | undefined) => {
  if (!Array.isArray(content)) throw new Error("expected a block list");

  return content;
};

const blocksOf = (message: Message | undefined) => list(message?.content);

/** A deep copy without any `cache_control`, at every depth. */
const strip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value), (key, entry) =>
    key === "cache_control" ? undefined : entry,
  );

/** A block without its own `cache_control`; nested ones stay. */
const unmarkedBlock = (entry: Block) =>
  Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "cache_control"),
  );

/** JSON with object keys sorted, as Python's `json.dumps(sort_keys=True)`. */
const sortedJson = <T>(value: T) =>
  JSON.stringify(value, (_, entry) =>
    entry instanceof Object && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : entry,
  );

const UNRESTORED =
  "Native request does not uniquely match the queried tool results";

const ok = () => new Response(null, { status: 200 });
let received: string[] = [];
let respond: () => Response = ok;

const peer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    received.push(await request.text());

    return respond();
  },
});

const UPSTREAM = `http://127.0.0.1:${peer.port}`;

afterEach(() => {
  received = [];
  respond = ok;
});

afterAll(() => peer.stop(true));

const post = (
  gate: Admission,
  payload: string,
  headers: Record<string, string> = {},
  path = "/v1/messages",
) =>
  fetch(`${gate.url}${path}`, {
    method: "POST",
    body: payload,
    headers: { "content-type": "application/json", ...headers },
  });

/** Send one native request through a fresh admission relay. */
async function relay(payload: string, queried: Block[] | undefined) {
  const gate = new Admission(UPSTREAM, 5000, queried);

  try {
    const response = await post(gate, payload);
    const text = await response.text();

    return { gate, status: response.status, text };
  } finally {
    await gate.close();
  }
}

describe("stable request context (test_admission_stable_context.py)", () => {
  const ENV = "Fixture environment";
  const DATE = "Today's date is 2031-01-01.";
  const FRAME = { type: "text", text: "Next user question" };
  const REMINDER = { type: "text", text: "Native context reminder" };
  const MARK = { type: "ephemeral", ttl: "1h" };
  const OTHER = { type: "ephemeral", ttl: "5m" };

  const ASSISTANT: Message = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Fixture reasoning",
        signature: "fixture-signature",
      },
      { type: "text", text: "Previous answer" },
    ],
  };

  const wire = (messages: Message[]) =>
    JSON.stringify({ model: "fixture", messages });

  const native = (
    env: string | Block[] = ENV,
    tail: string | Block[] = DATE,
  ): Message[] =>
    structuredClone([
      { role: "system", content: env },
      ASSISTANT,
      { role: "user", content: [REMINDER, FRAME] },
      { role: "system", content: tail },
    ]);

  const LIST_ENV = [
    { type: "text", text: "Earlier" },
    { type: "text", text: ENV },
  ];

  test.each([
    [ENV, DATE],
    [ENV, [{ type: "text", text: DATE }]],
    [LIST_ENV, DATE],
    [LIST_ENV, [{ type: "text", text: DATE }]],
  ])(
    "date returns to string or list environment %#",
    (env: string | Block[], tail: string | Block[]) => {
      const out = parse(
        stableRequestContext(wire(native(env, tail)), [FRAME]),
      ).messages;

      expect(out).toHaveLength(3);

      if (Array.isArray(env))
        expect(out[0]?.content).toEqual([
          ...env.slice(0, 1),
          { type: "text", text: `${ENV}\n\n${DATE}` },
        ]);
      else expect(out[0]?.content).toBe(`${ENV}\n\n${DATE}`);
      expect(out[1]).toEqual(ASSISTANT);
      expect(out[2]?.content).toEqual([FRAME]);
    },
  );

  test.each([
    "Today's date is 2031-01-01. Now 09:30.",
    "Per-request note",
    "Today's date is soon.",
  ])("trailing text other than the date line stays in place: %s", (tail) => {
    const out = parse(
      stableRequestContext(wire(native(ENV, tail)), [FRAME]),
    ).messages;

    expect(out[0]?.content).toBe(ENV);
    expect(out.at(-1)).toEqual({ role: "system", content: tail });
    expect(out.at(-2)?.content).toEqual([FRAME]);
  });

  test.each([ENV + DATE, `${ENV}\n${DATE}`])(
    "environment already ending with the date is not given it twice %#",
    (env) => {
      const out = parse(
        stableRequestContext(wire(native(env)), [FRAME]),
      ).messages;

      expect(out[0]?.content).toBe(env);
      expect(out.at(-1)).toEqual({ role: "system", content: DATE });
    },
  );

  test("reminder equal to the frame start is still dropped", () => {
    const messages = native().slice(0, -1);
    const last = messages.at(-1);

    if (last) last.content = [REMINDER, REMINDER, FRAME];

    const out = parse(
      stableRequestContext(wire(messages), [REMINDER, FRAME]),
    ).messages;

    expect(out.at(-1)?.content).toEqual([REMINDER, FRAME]);
  });

  test.each([
    [
      [
        { type: "text", text: "ab" },
        { type: "text", text: "a" },
      ],
      [
        { type: "text", text: "a" },
        { type: "text", text: "ba" },
      ],
    ],
    [[FRAME, FRAME], [FRAME]],
  ])(
    "frame not found exactly once is left as native built it %#",
    (blocks: Block[], queried: Block[]) => {
      const messages = native().slice(0, -1);
      const last = messages.at(-1);

      if (last) last.content = blocks;

      expect(stableRequestContext(wire(messages), queried)).toBe(
        wire(messages),
      );
    },
  );

  test.each([false, true])(
    "removed markers transfer with setdefault and never multiply (existing: %p)",
    (existing) => {
      const messages = native(ENV, [
        { type: "text", text: DATE, cache_control: MARK },
      ]);

      const frame = blocksOf(messages[2]);

      if (frame[0]) frame[0].cache_control = MARK;

      if (existing && frame[1]) frame[1].cache_control = OTHER;

      const out = parse(stableRequestContext(wire(messages), [FRAME])).messages;

      expect(out.at(-1)?.content).toEqual([
        { ...FRAME, cache_control: existing ? OTHER : MARK },
      ]);

      expect(
        out
          .filter((item) => Array.isArray(item.content))
          .flatMap(blocksOf)
          .filter((entry) => "cache_control" in entry),
      ).toHaveLength(1);
    },
  );

  test("reminder marker moves onto frame and suffix is kept", () => {
    const messages = native().slice(0, -1);
    const last = messages.at(-1);

    if (last)
      last.content = [
        { ...REMINDER, cache_control: MARK },
        REMINDER,
        FRAME,
        REMINDER,
      ];

    const out = parse(stableRequestContext(wire(messages), [FRAME])).messages;

    expect(out.at(-1)?.content).toEqual([
      { ...FRAME, cache_control: MARK },
      REMINDER,
    ]);
  });

  test.each([
    "tool_result",
    "opening",
    "protected",
    "missing",
    "already_stable",
    "multiple_tail",
  ])("ineligible context is byte unchanged: %s", (variant) => {
    const messages = native().slice(0, -1);
    const last = messages.at(-1);
    let queried: Block[] = [FRAME];

    if (!last) throw new Error("fixture has a user frame");

    if (variant === "tool_result") {
      queried = [
        { type: "tool_result", tool_use_id: "fixture-tool", content: "output" },
      ];
      last.content = queried;
    } else if (variant === "opening") messages.splice(1, 1);
    else if (variant === "protected") {
      const reminder = blocksOf(last)[0];

      if (reminder) reminder["citations"] = [];
    } else if (variant === "missing")
      queried = [{ type: "text", text: "Absent frame" }];
    else if (variant === "already_stable") {
      const environment = messages[0];

      if (environment) environment.content = `${ENV}\n\n${DATE}`;
      last.content = [FRAME];
      messages.push({ role: "system", content: DATE });
    } else {
      last.content = [FRAME];
      messages.push({
        role: "system",
        content: [REMINDER, { type: "text", text: DATE }],
      });
    }

    const payload = wire(messages);

    expect(stableRequestContext(payload, queried)).toBe(payload);
  });

  test.each([
    "not json",
    "\xff",
    "{}",
    "null",
    '{"messages":[null]}',
    JSON.stringify({
      model: "fixture",
      messages: [
        { role: "system", content: ENV },
        { role: "system", content: [{ type: "text", text: 42 }] },
      ],
    }),
  ])("unparseable or unexpected payload is byte unchanged %#", (payload) => {
    expect(stableRequestContext(payload, [FRAME])).toBe(payload);
  });

  test("transform is idempotent", () => {
    const once = stableRequestContext(wire(native()), [FRAME]);

    expect(stableRequestContext(once, [FRAME])).toBe(once);
  });

  test("consecutive per-call requests share byte-identical prompt prefix", async () => {
    const forward = async (payload: string, queried: Block[]) => {
      const { gate, status } = await relay(payload, queried);

      expect(status).toBe(200);
      expect(gate.failure).toBeUndefined();

      return parse(received.at(-1) ?? "").messages;
    };

    const first = await forward(wire(native()), [FRAME]);
    const nextFrame = { type: "text", text: "Follow-up question" };

    const messages: Message[] = [
      ...native().slice(0, 2),
      { role: "user", content: [FRAME] },
      structuredClone(ASSISTANT),
      { role: "user", content: [REMINDER, nextFrame] },
      { role: "system", content: DATE },
    ];

    const second = await forward(wire(messages), [nextFrame]);

    expect(first).toHaveLength(3);
    expect(first.at(-1)?.content).toEqual([FRAME]);
    expect(wire(second.slice(0, first.length))).toBe(wire(first));
    expect(second[first.length]).toEqual(ASSISTANT);
    expect(second.at(-1)?.content).toEqual([nextFrame]);
  });
});

describe("message breakpoint (test_admission_breakpoint.py)", () => {
  const MARKER = { type: "ephemeral" };

  const ASSISTANT: Message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "signed", signature: "sig" },
      { type: "tool_use", id: "t1", name: "mcp__hermes__probe", input: {} },
    ],
  };

  const RESULT = {
    type: "tool_result",
    tool_use_id: "t1",
    content: "real output",
  };

  const QUESTION = { type: "text", text: "the real question" };

  const wire = (messages: Message[]) =>
    JSON.stringify({ model: "m", messages });

  const marks = (payload: string) =>
    parse(payload).messages.flatMap((item, i) =>
      blocksOf(item).flatMap((entry, j): At[] =>
        "cache_control" in entry ? [[i, j]] : [],
      ),
    );

  const unmarked = (payload: string) =>
    parse(payload).messages.map((item) => ({
      ...item,
      content: blocksOf(item).map(unmarkedBlock),
    }));

  const withMarker = (entry: Block) => ({ ...entry, cache_control: MARKER });

  // Shapes native has used plus wording no relay has seen: the breakpoint lands on the last block that is exactly
  // the host's own content.
  const moves: [Block[], Message[], At][] = [
    // 2.1.280 tool round: reminder appended inside the tool_result, then a separate date message
    [
      [RESULT],
      [
        ASSISTANT,
        {
          role: "user",
          content: [
            {
              ...RESULT,
              content:
                "real output\n<system-reminder>userEmail</system-reminder>",
            },
          ],
        },
        {
          role: "system",
          content: [
            withMarker({ type: "text", text: "Today's date is 2026-09-23." }),
          ],
        },
      ],
      [0, 1],
    ],
    // an annotation after the host content, in wording no heuristic knows
    [
      [QUESTION],
      [
        ASSISTANT,
        {
          role: "user",
          content: [
            QUESTION,
            withMarker({ type: "text", text: "Session context: v9 build" }),
          ],
        },
      ],
      [1, 0],
    ],
    // an annotation prepended to the newest turn: nothing of that turn recurs
    [
      [QUESTION],
      [
        ASSISTANT,
        {
          role: "user",
          content: [
            { type: "text", text: "Any new preamble" },
            withMarker(QUESTION),
          ],
        },
      ],
      [0, 1],
    ],
    // tool results then the user's own text, native's reminder in that text: the results recur
    [
      [RESULT, QUESTION],
      [
        ASSISTANT,
        {
          role: "user",
          content: [
            RESULT,
            withMarker({
              ...QUESTION,
              text: "the real question\n<system-reminder>x</system-reminder>",
            }),
          ],
        },
      ],
      [1, 0],
    ],
    // every queried block unchanged, native's date in its own message after them
    [
      [RESULT],
      [
        ASSISTANT,
        { role: "user", content: [RESULT] },
        {
          role: "system",
          content: [
            withMarker({ type: "text", text: "Today's date is 2026-09-23." }),
          ],
        },
      ],
      [1, 0],
    ],
    // a block native appends after unchanged tool results: the results recur
    [
      [RESULT],
      [
        ASSISTANT,
        {
          role: "user",
          content: [
            RESULT,
            withMarker({ type: "text", text: "Session context: v9 build" }),
          ],
        },
      ],
      [1, 0],
    ],
  ];

  test.each(moves)(
    "breakpoint moves to the last block the host itself sent %#",
    (queried: Block[], messages: Message[], expected: At) => {
      const raw = wire(messages);
      const out = pinMessageBreakpoint(raw, queried);

      expect(marks(out)).toEqual([expected]);
      // only the directive moves, never content
      expect(unmarked(out)).toEqual(unmarked(raw));
    },
  );

  test.each([2, 4])(
    "parallel tool results do not pin inside a partly changed user message (%p)",
    (count) => {
      const results = Array.from({ length: count }, (_, i) => ({
        type: "tool_result",
        tool_use_id: `t${i}`,
        content: `output ${i}`,
      }));

      const assistant: Message = {
        role: "assistant",
        content: Array.from({ length: count }, (_, i) => ({
          type: "tool_use",
          id: `t${i}`,
          name: `probe_${i}`,
          input: {},
        })),
      };

      const lastResult = results[count - 1];

      if (!lastResult) throw new Error("fixture has results");

      const changedLast = {
        ...lastResult,
        content: `${lastResult.content}\n<system-reminder>native note</system-reminder>`,
      };

      const raw = wire([
        assistant,
        {
          role: "user",
          content: [...results.slice(0, -1), withMarker(changedLast)],
        },
      ]);

      const out = pinMessageBreakpoint(raw, results);

      expect(marks(out)).toEqual([[0, count - 1]]);
      expect(unmarked(out)).toEqual(unmarked(raw));
    },
  );

  test.each([
    [
      wire([
        ASSISTANT,
        { role: "user", content: [RESULT, withMarker(QUESTION)] },
      ]),
      [RESULT, QUESTION],
    ],
    [
      wire([
        {
          role: "user",
          content: [withMarker({ type: "text", text: "Any preamble" })],
        },
      ]),
      [QUESTION],
    ],
    ["not json", [QUESTION]],
    [
      wire([ASSISTANT, { role: "user", content: [withMarker(RESULT)] }]),
      undefined,
    ],
  ])(
    "stable breakpoint or nothing to anchor forwards unchanged %#",
    (payload: string, queried: Block[] | undefined) => {
      expect(pinMessageBreakpoint(payload, queried)).toBe(payload);
    },
  );

  test("native email annotation is not forwarded as tool output", () => {
    const native = {
      ...RESULT,
      content:
        "real output\n<system-reminder>userEmail: matt@example.com</system-reminder>",
    };

    const messages: Message[] = [
      ASSISTANT,
      { role: "user", content: [native] },
      {
        role: "system",
        content: [{ type: "text", text: "Today's date is 2026-09-30." }],
      },
    ];

    const out = parse(restoreQueriedTurn(wire(messages), [RESULT]));

    expect(out.messages[1]?.content).toEqual([RESULT]);
    expect(out.messages[2]).toEqual(messages[2]);
  });

  test("original reminder in tool result is preserved", () => {
    const original = {
      ...RESULT,
      content: "real output\n<system-reminder>quoted fixture</system-reminder>",
    };

    const native = {
      ...original,
      content: `${original.content}\n<system-reminder>userEmail</system-reminder>`,
    };

    const out = parse(
      restoreQueriedTurn(
        wire([ASSISTANT, { role: "user", content: [native] }]),
        [original],
      ),
    );

    expect(out.messages[1]?.content).toEqual([original]);
  });

  test("parallel results and native trailing block restore the host frame", () => {
    const second = {
      type: "tool_result",
      tool_use_id: "t2",
      content: "second output",
    };

    const native = [
      {
        ...RESULT,
        content: `${RESULT.content}\n<system-reminder>userEmail</system-reminder>`,
      },
      second,
      { type: "text", text: "native session context" },
    ];

    const out = parse(
      restoreQueriedTurn(wire([ASSISTANT, { role: "user", content: native }]), [
        RESULT,
        second,
      ]),
    );

    expect(out.messages[1]?.content).toEqual([RESULT, second]);
  });

  test("unmatched native tool result fails closed", () => {
    const changed = {
      ...RESULT,
      tool_use_id: "different",
      content: "real output\n<system-reminder>userEmail</system-reminder>",
    };

    const raw = wire([ASSISTANT, { role: "user", content: [changed] }]);

    expect(() => restoreQueriedTurn(raw, [RESULT])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("ambiguous native tool result fails closed", () => {
    const raw = wire([ASSISTANT, { role: "user", content: [RESULT, RESULT] }]);

    expect(() => restoreQueriedTurn(raw, [RESULT])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("unmatched plain user turn keeps native payload", () => {
    const raw = wire([
      ASSISTANT,
      { role: "user", content: [{ ...QUESTION, text: "rewritten" }] },
    ]);

    expect(restoreQueriedTurn(raw, [QUESTION])).toBe(raw);
  });

  test("admission forwards the host tool result without native email", async () => {
    respond = () => new Response(null, { status: 400 });

    const native = {
      ...RESULT,
      content: `${RESULT.content}\n<system-reminder>userEmail</system-reminder>`,
    };

    const { status } = await relay(
      wire([ASSISTANT, { role: "user", content: [native] }]),
      [RESULT],
    );

    expect(status).toBe(400);
    expect(parse(received[0] ?? "").messages[1]?.content).toEqual([RESULT]);
  });

  test("admission forwards an unmatched tool result unchanged", async () => {
    const changed = { ...RESULT, tool_use_id: "different" };
    const payload = wire([ASSISTANT, { role: "user", content: [changed] }]);
    const { gate } = await relay(payload, [RESULT]);

    expect(gate.unrestored).toBe(UNRESTORED);
    expect(gate.failure).toBeUndefined();
    expect(received).toEqual([payload]);
  });
});

describe("first turn (test_admission_first_turn.py)", () => {
  const MARKER = { type: "ephemeral", ttl: "1h" };

  const REMINDER = {
    type: "text",
    text:
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\n" +
      "The user's email address is a@example.invalid.\n</system-reminder>\n",
  };

  const FRAME = {
    type: "text",
    text: `Use the terminal tool to run \`echo alpha\`.${" source pack".repeat(200)}`,
  };

  const ENV =
    "Primary working directory: /tmp/claude-directsdk-cwd-501\nPlatform: darwin";

  /** Native's opening request: reminder ahead of the host frame, marker on the env/date message. */
  const call1 = (): Message[] => [
    { role: "user", content: [REMINDER, FRAME] },
    {
      role: "system",
      content: [
        {
          type: "text",
          text: `${ENV}\n\nToday's date is 2026-09-30.`,
          cache_control: MARKER,
        },
      ],
    },
  ];

  /** Native's second request: the same first turn replayed bare, one tool round, the date after it. */
  const call2 = (): Message[] => [
    { role: "user", content: [FRAME] },
    { role: "system", content: ENV },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "mcp__hermes__terminal",
          input: { command: "echo alpha" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: `alpha\n\n${REMINDER.text}`,
        },
      ],
    },
    {
      role: "system",
      content: [
        {
          type: "text",
          text: "Today's date is 2026-09-30.",
          cache_control: MARKER,
        },
      ],
    },
  ];

  const wire = (messages: Message[]) =>
    JSON.stringify({ model: "m", messages });

  const blocksAsSent = (item: Message): Block[] =>
    Array.isArray(item.content)
      ? item.content
      : [{ type: "text", text: item.content }];

  /** What the API caches for this request: every message block up to and including the marker. */
  const cachedPrefix = (payload: string) => {
    const blocks: [string, string][] = [];

    for (const item of parse(payload).messages)
      for (const entry of blocksAsSent(item)) {
        blocks.push([item.role, sortedJson(unmarkedBlock(entry))]);

        if ("cache_control" in entry) return blocks;
      }

    return undefined;
  };

  const replayed = (payload: string) =>
    parse(payload).messages.flatMap((item) =>
      blocksAsSent(item).map((entry): [string, string] => [
        item.role,
        sortedJson(unmarkedBlock(entry)),
      ]),
    );

  test("first request caches a prefix the second request replays", () => {
    const first = pinMessageBreakpoint(wire(call1()), [FRAME]);

    const second = pinMessageBreakpoint(wire(call2()), [
      { type: "tool_result", tool_use_id: "t1", content: "alpha" },
    ]);

    const prefix = cachedPrefix(first);

    expect(prefix).toBeDefined();
    // the whole cached span of call #1 recurs, block for block, at the head of call #2
    expect(replayed(second).slice(0, prefix?.length)).toEqual(prefix ?? []);
    // and it covers the host's first turn, the part that was being re-written
    expect(prefix?.at(-1)).toEqual(["user", sortedJson(FRAME)]);
  });

  test("first turn keeps every block and moves only the marker", () => {
    const out = parse(pinMessageBreakpoint(wire(call1()), [FRAME]));
    const firstTurn = blocksOf(out.messages[0]);

    // native's context still reaches the model, now after the host frame as on every later turn
    expect(firstTurn.map(unmarkedBlock)).toEqual([FRAME, REMINDER]);
    expect(firstTurn[0]?.cache_control).toEqual(MARKER);

    expect(
      out.messages
        .filter((item) => Array.isArray(item.content))
        .flatMap(blocksOf)
        .filter((entry) => "cache_control" in entry),
    ).toHaveLength(1);
    expect(blocksOf(out.messages[1])[0]?.text?.startsWith(ENV)).toBe(true);
  });

  test.each([
    // a later turn: there is history, the first turn is left exactly as native sent it
    [
      [...call2().slice(0, 3), { role: "user", content: [REMINDER, FRAME] }],
      [FRAME],
    ],
    // the frame occurs twice: ambiguous, forward as is
    [[{ role: "user", content: [REMINDER, FRAME, FRAME] }], [FRAME]],
    // something other than text ahead of the frame is not native's context block
    [
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AA==" },
            },
            FRAME,
          ],
        },
      ],
      [FRAME],
    ],
    // the frame is not in the turn at all (native rewrote it)
    [
      [
        {
          role: "user",
          content: [REMINDER, { type: "text", text: "rewritten" }],
        },
      ],
      [FRAME],
    ],
  ])(
    "first turn is only reordered when the frame is unambiguous %#",
    (fixture: Message[], queried: Block[]) => {
      const messages = structuredClone(fixture);
      const content = blocksOf(messages.at(-1));
      const tail = content.at(-1);

      if (tail)
        content[content.length - 1] = { ...tail, cache_control: MARKER };

      const raw = wire(messages);
      const out = parse(pinMessageBreakpoint(raw, queried));

      const unmarkedContent = (item: Message | undefined) =>
        Array.isArray(item?.content)
          ? item.content.map(unmarkedBlock)
          : item?.content;

      for (const [index, sent] of parse(raw).messages.entries()) {
        const got = out.messages[index];

        if (got) expect(unmarkedContent(got)).toEqual(unmarkedContent(sent));
      }
    },
  );
});

describe("two native marks (test_admission_two_marks.py)", () => {
  const MARKER = { type: "ephemeral" };

  // Native's own system/tools marks: with two message marks the request is at Anthropic's limit of four.
  const SYSTEM = [
    { type: "text", text: "x-anthropic-billing-header: cc" },
    {
      type: "text",
      text: "You are Claude Code. Hermes system prompt.",
      cache_control: MARKER,
    },
  ];

  const TOOLS: Tool[] = [
    {
      name: "mcp__hermes__terminal",
      description: "run",
      input_schema: { type: "object" },
      cache_control: MARKER,
    },
  ];

  const REMINDER =
    "\n<system-reminder>userEmail: user@example.com</system-reminder>";

  const toolsAsNative = (body: Body) =>
    (body.tools ?? []).map((tool) =>
      Object.fromEntries(
        Object.entries(tool).filter(([key]) => key !== "eager_input_streaming"),
      ),
    );

  const results = (n: number) =>
    Array.from({ length: 4 }, (_, k) => ({
      type: "tool_result",
      tool_use_id: `r${n}c${k}`,
      content: `output ${n}.${k}`,
    }));

  const assistant = (n: number): Message => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: `plan ${n}`, signature: `sig${n}` },
      ...Array.from({ length: 4 }, (_, k) => ({
        type: "tool_use",
        id: `r${n}c${k}`,
        name: "mcp__hermes__terminal",
        input: { command: `echo ${n}.${k}` },
      })),
    ],
  });

  /**
   * What native sends after `rounds` parallel rounds: older rounds replay as the host sent them, the newest
   * carries native's reminder (optionally) and is followed by its per-request context.
   */
  const nativeRequest = (rounds: number, reminder: boolean): Body => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "run four probes, twice" }],
      },
    ];

    for (let n = 0; n < rounds; n++)
      messages.push(assistant(n), { role: "user", content: results(n) });

    // native mark 1: last tool_use of the turn
    const markedUse = blocksOf(messages.at(-2)).at(-1);

    if (markedUse) markedUse.cache_control = MARKER;

    const newest = blocksOf(messages.at(-1)).at(-1);

    if (reminder && newest)
      newest.content = `${z.string().parse(newest.content)}${REMINDER}`;
    // native mark 2: per-request context, never replayed
    messages.push({
      role: "system",
      content: [
        {
          type: "text",
          text: `Today's date is 2026-10-04. Request ${rounds}.`,
          cache_control: MARKER,
        },
      ],
    });

    return {
      model: "claude-opus-5-5",
      system: structuredClone(SYSTEM),
      tools: structuredClone(TOOLS),
      messages,
    };
  };

  const messageMarks = (body: Body) =>
    body.messages.flatMap((item, i) =>
      blocksOf(item).flatMap((entry, j): At[] =>
        "cache_control" in entry ? [[i, j]] : [],
      ),
    );

  const markCount = (body: Body) =>
    [...(body.system ?? []), ...(body.tools ?? [])].filter(
      (entry) => "cache_control" in entry,
    ).length + messageMarks(body).length;

  /**
   * The request through block `at`, in the order the cache reads them (tools, system, messages). Markers are
   * left out: they move between requests and are not prompt content.
   */
  const prefix = (body: Body, [i, j]: At) => {
    const item = body.messages[i];

    if (!item) throw new Error("prefix past the last message");

    const head = [
      ...body.messages.slice(0, i),
      { ...item, content: blocksOf(item).slice(0, j + 1) },
    ];

    return JSON.stringify(
      strip({ tools: body.tools, system: body.system, messages: head }),
    );
  };

  /** Send one native request through a real admission relay; return the body that went upstream. */
  const forward = async (nativeBody: Body, queried: Block[]) => {
    received = [];

    const { gate, status } = await relay(JSON.stringify(nativeBody), queried);

    expect(status).toBe(200);
    expect(gate.unrestored).toBeUndefined();
    expect(gate.failure).toBeUndefined();
    expect(received).toHaveLength(1);

    return parse(received[0] ?? "");
  };

  test.each([false, true])(
    "two native marks keep one breakpoint the next request reads (reminder in last result: %p)",
    async (reminder) => {
      const nativeN = nativeRequest(1, reminder);
      const sentN = await forward(nativeN, results(0));
      const sentN1 = await forward(nativeRequest(2, reminder), results(1));

      // Native's mark on the last tool_use recurs and stays; the trailing system message's mark moves onto the
      // last tool result (which, restored to the host frame, recurs).
      expect(messageMarks(nativeN)).toEqual([
        [1, 4],
        [3, 0],
      ]);

      expect(messageMarks(sentN)).toEqual([
        [1, 4],
        [2, 3],
      ]);

      expect(messageMarks(sentN1)).toEqual([
        [3, 4],
        [4, 3],
      ]);
      // Only a marker moved: same content, same system/tools marks, never more than native's four.
      expect(sentN.system).toEqual(nativeN.system);
      expect(toolsAsNative(sentN)).toEqual(nativeN.tools ?? []);
      expect(strip(sentN.messages[3])).toEqual(strip(nativeN.messages[3]));
      expect(markCount(sentN)).toBe(4);
      expect(markCount(nativeN)).toBe(4);

      // Request N+1 replays request N's prefix through its last breakpoint byte for byte, so the entry N wrote
      // is read instead of the round being written again.
      const last = messageMarks(sentN).at(-1);

      if (!last) throw new Error("request N kept a mark");
      expect(prefix(sentN1, last)).toBe(prefix(sentN, last));
    },
  );

  test("unrestorable result falls back to native tool_use mark", () => {
    const native = nativeRequest(1, true);

    const sent = parse(
      pinMessageBreakpoint(JSON.stringify(native), results(0)),
    );

    expect(messageMarks(sent)).toEqual([[1, 4]]);
    expect(markCount(sent)).toBe(markCount(native) - 1);
    expect(strip(sent)).toEqual(strip(native));
    expect(sent.system).toEqual(native.system);
    expect(sent.tools).toEqual(native.tools);

    const following = nativeRequest(2, true);

    expect(prefix(following, [1, 4])).toBe(prefix(sent, [1, 4]));
  });

  test("marks inside the recurring span are left alone", () => {
    const native = nativeRequest(1, false);

    // no trailing context message
    native.messages.pop();

    const lastResult = blocksOf(native.messages[2]).at(-1);

    if (lastResult) lastResult.cache_control = MARKER;

    const raw = JSON.stringify(native);

    expect(pinMessageBreakpoint(raw, results(0))).toBe(raw);
  });
});

describe("turn start (test_admission_turn_start.py)", () => {
  const MARKER = { type: "ephemeral", ttl: "1h" };

  const OPENING = {
    type: "text",
    text: `Run the echo steps one at a time.${" source pack".repeat(200)}`,
  };

  const FOLLOW_UP = { type: "text", text: "One more echo." };

  const STEER = {
    type: "text",
    text: "User sent a /steer: also print the date.",
  };

  const REMINDER =
    "\n<system-reminder>userEmail: user@example.invalid</system-reminder>";

  type Layout = "2.1.285" | "2.1.287";

  const LAYOUT_NAMES: Layout[] = ["2.1.285", "2.1.287"];

  // tools, system, whether native also marks the last assistant block
  const LAYOUTS: Record<Layout, [Tool[], Block[], boolean]> = {
    "2.1.285": [
      [
        {
          name: "mcp__hermes__terminal",
          description: "run",
          input_schema: { type: "object" },
        },
      ],
      [
        { type: "text", text: "x-anthropic-billing-header: cc" },
        { type: "text", text: "You are Claude Code.", cache_control: MARKER },
        { type: "text", text: "Hermes system prompt.", cache_control: MARKER },
      ],
      false,
    ],
    "2.1.287": [
      [
        {
          name: "mcp__hermes__terminal",
          description: "run",
          input_schema: { type: "object" },
          cache_control: MARKER,
        },
      ],
      [
        { type: "text", text: "x-anthropic-billing-header: cc" },
        {
          type: "text",
          text: "You are Claude Code. Hermes system prompt.",
          cache_control: MARKER,
        },
      ],
      true,
    ],
  };

  const thinking = (n: number) => ({
    type: "thinking",
    thinking: `plan ${n}`,
    signature: `sig${n}`,
  });

  const assistant = (n: number, think: boolean, calls: number): Message => ({
    role: "assistant",
    content: [
      ...(think ? [thinking(n)] : []),
      ...Array.from({ length: calls }, (_, k) => ({
        type: "tool_use",
        id: `t${n}c${k}`,
        name: "mcp__hermes__terminal",
        input: { command: `echo ${n}.${k}` },
      })),
    ],
  });

  /**
   * The host's messages for one turn: its opening, `rounds` tool rounds and the answer. Round n's assistant
   * message thinks when `think(n)`; a /steer row rides in the results of round `steer`.
   */
  const turn = (
    opening: Block,
    rounds: number,
    think: (n: number) => boolean,
    calls = 1,
    steer?: number,
    start = 0,
  ): Message[] => {
    const messages: Message[] = [{ role: "user", content: [opening] }];

    for (let n = start; n < start + rounds; n++)
      messages.push(assistant(n, think(n), calls), {
        role: "user",
        content: [
          ...Array.from({ length: calls }, (_, k) => ({
            type: "tool_result",
            tool_use_id: `t${n}c${k}`,
            content: `${n}.${k}`,
          })),
          ...(n === steer ? [STEER] : []),
        ],
      });

    const n = start + rounds;

    return [
      ...messages,
      {
        role: "assistant",
        content: [
          ...(think(n) ? [thinking(n)] : []),
          { type: "text", text: `done ${n}` },
        ],
      },
    ];
  };

  /**
   * Native's request for a history ending in a user frame: its env message after the first turn and its
   * per-request date message last, which is where it puts the message mark.
   */
  const native = (messages: Message[], layout: Layout): Body => {
    const [tools, system, assistantMark] = LAYOUTS[layout];
    const sent = structuredClone(messages);

    sent.splice(1, 0, {
      role: "system",
      content: "Primary working directory: /tmp/claude-directsdk-cwd",
    });

    const lastAssistantBlock =
      assistantMark && sent.length > 3
        ? blocksOf(sent.at(-2)).at(-1)
        : undefined;

    if (lastAssistantBlock) lastAssistantBlock.cache_control = MARKER;
    sent.push({
      role: "system",
      content: [
        {
          type: "text",
          text: "Today's date is 2026-10-10.",
          cache_control: MARKER,
        },
      ],
    });

    return {
      model: "claude-opus-5-5",
      tools: structuredClone(tools),
      system: structuredClone(system),
      messages: sent,
    };
  };

  /** The body the relay forwards for the request that queries the last message of `messages`. */
  const pinned = (messages: Message[], layout: Layout) =>
    parse(
      pinMessageBreakpoint(
        JSON.stringify(native(messages, layout)),
        blocksOf(messages.at(-1)),
      ),
    );

  type Where = At | "tools" | "system";

  type Item = { type?: string; cache_control?: Mark | undefined };

  /**
   * Anthropic's documented lookup: each breakpoint checks up to 20 positions back, itself included, a run of
   * tool_use or tool_result blocks counting once; entries are written only at breakpoints. A thinking block
   * renders closed once a later user message carries more than tool results.
   */
  class Cache {
    private readonly entries = new Set<string>();

    /** Where this request's read ends: a message block, "system" or undefined. */
    send(body: Body): Where | undefined {
      const { messages } = body;

      const opens = messages.map(
        (item) =>
          item.role === "user" &&
          Array.isArray(item.content) &&
          item.content.some((entry) => entry.type !== "tool_result"),
      );

      const flat: { where: Where; item: Item; key: string }[] = [];
      const hasher = new Bun.CryptoHasher("sha256");

      const add = (where: Where, item: Item, hashed: Item) => {
        hasher.update(
          sortedJson([Array.isArray(where) ? where[0] : where, strip(hashed)]),
        );
        flat.push({ where, item, key: hasher.copy().digest("hex") });
      };

      for (const tool of body.tools ?? []) add("tools", tool, tool);

      for (const entry of body.system ?? []) add("system", entry, entry);

      for (const [i, item] of messages.entries()) {
        const content = Array.isArray(item.content)
          ? item.content
          : [{ type: "text", text: item.content }];

        for (const [j, entry] of content.entries())
          add(
            [i, j],
            entry,
            entry.type === "thinking"
              ? { ...entry, closed: opens.slice(i + 1).some(Boolean) }
              : entry,
          );
      }

      const marks = flat.flatMap((entry, k) =>
        entry.item.cache_control ? [k] : [],
      );

      let read = -1;

      for (const mark of marks) {
        let k = mark;
        let seen = 1;

        while (k >= 0 && seen <= 20) {
          if (this.entries.has(flat[k]?.key ?? "")) {
            read = Math.max(read, k);
            break;
          }

          const kind = flat[k]?.item.type;

          k -= 1;

          if (
            !(
              (kind === "tool_use" || kind === "tool_result") &&
              k >= 0 &&
              flat[k]?.item.type === kind
            )
          )
            seen += 1;
        }
      }

      for (const mark of marks) this.entries.add(flat[mark]?.key ?? "");

      return read < 0 ? undefined : flat[read]?.where;
    }
  }

  const messageMarks = (body: Body) =>
    body.messages.flatMap((item, i) =>
      Array.isArray(item.content)
        ? item.content.flatMap((entry, j): At[] =>
            "cache_control" in entry ? [[i, j]] : [],
          )
        : [],
    );

  /** Every breakpoint the API counts toward its four: nested markers and a top-level one included. */
  const markCount = (value: Body | Message) => {
    let count = 0;

    JSON.parse(JSON.stringify(value), (key, entry) => {
      if (key === "cache_control") count++;

      return entry;
    });

    return count;
  };

  /**
   * Send every request of the conversation in order; return (forwarded body, read) per request. Only markers ever
   * change, and never past four or more than one over native's own count.
   */
  const replay = (messages: Message[], layout: Layout) => {
    const cache = new Cache();
    const out: [Body, Where | undefined][] = [];

    for (const [i, item] of messages.entries()) {
      if (item.role !== "user") continue;
      const raw = native(messages.slice(0, i + 1), layout);
      const body = pinned(messages.slice(0, i + 1), layout);

      expect(strip(body)).toEqual(strip(raw));
      expect(body.tools).toEqual(raw.tools);
      expect(body.system).toEqual(raw.system);
      expect(markCount(body)).toBeLessThanOrEqual(
        Math.min(4, markCount(raw) + 1),
      );
      out.push([body, cache.send(body)]);
    }

    return out;
  };

  // native's env message sits at messages[1]
  const nativeIndex = (i: number) => (i ? i + 1 : 0);

  const lastRead = (sent: [Body, Where | undefined][]) => sent.at(-1)?.[1];

  describe.each(LAYOUT_NAMES)("layout %s", (layout) => {
    test.each([0, 6])(
      "next turn after a long loop reads up to the finished turn's first thinking (thinks from round %p)",
      (first) => {
        const think = (n: number) => [first, 9, 14].includes(n);

        const messages = [
          ...turn(OPENING, 14, think),
          { role: "user", content: [FOLLOW_UP] },
        ];

        const sent = replay(messages, layout);
        // Host index of the frame before the first thinking: the opening, or round first-1's results.
        const anchor: At = [nativeIndex(2 * first), 0];
        const [body, read] = sent.at(-1) ?? [];

        if (!body) throw new Error("replay sent requests");
        expect(messageMarks(body)).toContainEqual(anchor);
        // not "system": only the finished loop from its first thinking is written again
        expect(read).toEqual(anchor);

        // Within the loop each request still reads the previous one's recurring breakpoint.
        for (const [k, [before]] of sent.slice(0, -2).entries())
          expect(sent[k + 1]?.[1]).toEqual(messageMarks(before).at(-1));
      },
    );

    test("short loop is forwarded with the recurring mark only", () => {
      const messages = [
        ...turn(OPENING, 4, () => true),
        { role: "user", content: [FOLLOW_UP] },
      ];

      const sent = replay(messages, layout);
      const assistantMark = LAYOUTS[layout][2];

      // 2.1.287+'s own mark on the last assistant block stays; nothing is added.
      for (const [body] of sent)
        expect(messageMarks(body)).toHaveLength(
          1 + Number(assistantMark && body.messages.length > 4),
        );
      // the recurring breakpoint's own lookback still reaches the opening
      expect(lastRead(sent)).toEqual([0, 0]);
    });

    test("steer row after a long loop reads up to the turn's first thinking", () => {
      const messages = turn(OPENING, 14, () => true, 1, 11);
      const sent = replay(messages, layout);

      const steer = sent.findIndex(([body]) => {
        const content = body.messages.at(-2)?.content;

        return (
          Array.isArray(content) && Bun.deepEquals(strip(content.at(-1)), STEER)
        );
      });

      const [body, read] = sent[steer] ?? [];

      if (!body) throw new Error("a request carried the steer row");
      expect(read).toEqual([0, 0]);
      expect(messageMarks(body)).toContainEqual([0, 0]);
      // After the steer the open turn starts at the steer row; the next request reads the steer request's entry.
      expect(sent[steer + 1]?.[1]).toEqual(messageMarks(body).at(-1));
    });

    test("parallel rounds then a new turn read up to the first thinking", () => {
      const messages = [
        ...turn(OPENING, 6, () => true, 4),
        { role: "user", content: [FOLLOW_UP] },
      ];

      expect(lastRead(replay(messages, layout))).toEqual([0, 0]);
    });

    test("a nested marker takes a slot so the request stays at four", () => {
      // A marker inside a historical tool_result's content (a host marker restoration carried back) counts toward
      // the four: 2.1.285 has no slot left and forwards the fold only, 2.1.287+ moves its mark on the last
      // assistant block. Neither forwards a fifth, which the API rejects.
      const messages = [
        ...turn(OPENING, 14, () => true),
        { role: "user", content: [FOLLOW_UP] },
      ];

      const raw = native(messages, layout);
      const tool = raw.tools?.[0];

      if (tool) delete tool.cache_control;

      const nested = blocksOf(raw.messages[5])[0];

      if (nested)
        nested.content = [{ type: "text", text: "1.0", cache_control: MARKER }];

      const body = parse(
        pinMessageBreakpoint(JSON.stringify(raw), blocksOf(messages.at(-1))),
      );

      expect(markCount(body)).toBe(4);
      expect(markCount(raw)).toBe(4);
      expect(body.messages[5]).toEqual(raw.messages[5]);

      expect(messageMarks(body)).toEqual(
        layout === "2.1.285"
          ? [[31, 0]]
          : [
              [0, 0],
              [31, 0],
            ],
      );
      expect(strip(body)).toEqual(strip(raw));
      expect(body.tools).toEqual(raw.tools);
      expect(body.system).toEqual(raw.system);
    });
  });

  test("a later turn keeps everything before the finished turn", () => {
    // Turn 2 runs the long loop: turn 3's first call reads all of turn 1 and turn 2's opening.
    const first = turn(OPENING, 1, () => true);
    const second = turn(FOLLOW_UP, 14, () => true, 1, undefined, 1);

    const messages = [
      ...first,
      ...second,
      { role: "user", content: [{ type: "text", text: "And again." }] },
    ];

    const [body, read] = replay(messages, "2.1.285").at(-1) ?? [];

    expect(nativeIndex(first.length)).toBe(5);
    expect(read).toEqual([5, 0]);

    if (!body) throw new Error("replay sent requests");
    expect(markCount(body)).toBe(4);
  });

  test("loop without thinking is left to the recurring mark", () => {
    const messages = [
      ...turn(OPENING, 14, () => false),
      { role: "user", content: [FOLLOW_UP] },
    ];

    const sent = replay(messages, "2.1.285");

    for (const [body] of sent) expect(messageMarks(body)).toHaveLength(1);

    const previous = sent.at(-2)?.[0];

    if (!previous) throw new Error("replay sent requests");
    // nothing closes: the whole loop is read
    expect(lastRead(sent)).toEqual(messageMarks(previous).at(-1));
  });

  test("at the limit a native mark moves instead of a fifth", () => {
    // 2.1.287+ with a tools mark is at four: native's mark on the last assistant block is the one the next request
    // does not need (the recurring breakpoint follows it), so it moves.
    const messages = [
      ...turn(OPENING, 14, () => true),
      { role: "user", content: [FOLLOW_UP] },
    ];

    const raw = native(messages, "2.1.287");
    const body = pinned(messages, "2.1.287");

    expect(markCount(raw)).toBe(4);
    expect(markCount(body)).toBe(4);

    expect(messageMarks(raw)).toEqual([
      [30, 1],
      [32, 0],
    ]);

    expect(messageMarks(body)).toEqual([
      [0, 0],
      [31, 0],
    ]);
    expect(strip(body)).toEqual(strip(raw));
    expect(body.tools).toEqual(raw.tools);
    expect(body.system).toEqual(raw.system);
  });

  test("no spare slot and no native mark to move forwards the fold only", () => {
    const messages = [
      ...turn(OPENING, 14, () => true),
      { role: "user", content: [FOLLOW_UP] },
    ];

    const raw = native(messages, "2.1.285");
    const tool = raw.tools?.[0];

    if (tool) tool.cache_control = MARKER;
    // top-level automatic caching takes a slot too
    raw.cache_control = { type: "ephemeral" };

    const body = parse(
      pinMessageBreakpoint(JSON.stringify(raw), blocksOf(messages.at(-1))),
    );

    expect(messageMarks(body)).toEqual([[31, 0]]);
  });

  test("turn mark takes the ttl of the mark after it", () => {
    const messages = [
      ...turn(OPENING, 14, () => true),
      { role: "user", content: [FOLLOW_UP] },
    ];

    const raw = native(messages, "2.1.285");
    const date = blocksOf(raw.messages.at(-1))[0];

    if (date) date.cache_control = { type: "ephemeral" };

    const body = parse(
      pinMessageBreakpoint(JSON.stringify(raw), blocksOf(messages.at(-1))),
    );

    expect(blocksOf(body.messages[0])[0]?.cache_control).toEqual({
      type: "ephemeral",
    });

    expect(blocksOf(body.messages[31])[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("relay forwards the turn mark with the steer frame restored", async () => {
    // Through the real relay: native's reminder on the last tool result is restored away, the steer frame recurs,
    // and the turn mark is on the opening frame.
    const messages = turn(OPENING, 14, () => true, 1, 11);

    const end =
      messages.findIndex((item) =>
        blocksOf(item).some((entry) => Bun.deepEquals(entry, STEER)),
      ) + 1;

    const raw = native(messages.slice(0, end), "2.1.285");
    const result = blocksOf(raw.messages.at(-2))[0];

    if (result)
      result.content = `${z.string().parse(result.content)}${REMINDER}`;

    const queried = blocksOf(messages[end - 1]);
    const { gate, status } = await relay(JSON.stringify(raw), queried);

    expect(status).toBe(200);
    expect(gate.unrestored).toBeUndefined();
    expect(gate.failure).toBeUndefined();

    const sent = parse(received[0] ?? "");

    // The relay returns native's trailing date message to its env message, so the steer frame is last.
    expect(sent.messages.at(-1)?.role).toBe("user");

    expect(
      z
        .string()
        .parse(sent.messages[1]?.content)
        .endsWith("Today's date is 2026-10-10."),
    ).toBe(true);
    expect(strip(sent.messages.at(-1)?.content)).toEqual(queried);

    expect(messageMarks(sent)).toEqual([
      [0, 0],
      [sent.messages.length - 1, 1],
    ]);
    expect(markCount(sent)).toBe(4);
  });
});

describe("restoration (test_admission_restoration.py)", () => {
  const RESULT = { type: "tool_result", tool_use_id: "t1", content: "output" };

  const ASSISTANT: Message = {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "probe", input: {} }],
  };

  const IMAGE = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AA==" },
  };

  const wire = (
    content: Block[],
    before: Message[] = [ASSISTANT],
    after: Message[] = [],
  ) =>
    JSON.stringify({
      model: "fixture",
      messages: [...before, { role: "user", content }, ...after],
    });

  /** RESULT with an `is_error` the Block type cannot hold, appended last as Python's `{**RESULT, ...}`. */
  const withErrorFlag = (flag: string) => {
    const plain = wire([RESULT]);

    const flagged = plain.replace(
      '"content":"output"}',
      `"content":"output","is_error":${flag}}`,
    );

    expect(flagged).not.toBe(plain);

    return flagged;
  };

  const equivalents: Block[] = [
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: "output",
      is_error: false,
    },
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "output" }],
    },
    {
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "output" }],
      is_error: false,
    },
  ];

  test.each(equivalents)(
    "equivalent plain tool result shapes restore exact host shape %#",
    (nativeResult: Block) => {
      const host = structuredClone(RESULT);
      const restored = parse(restoreQueriedTurn(wire([nativeResult]), [host]));

      expect(restored.messages[1]?.content).toEqual([host]);
    },
  );

  test.each(["0", "null", '"false"'])(
    "invalid error flag cannot normalize to success (%s)",
    (flag) => {
      expect(() => restoreQueriedTurn(withErrorFlag(flag), [RESULT])).toThrow(
        QueriedTurnMismatch,
      );
    },
  );

  test("true tool error does not match absent is_error", () => {
    const raw = wire([{ ...RESULT, is_error: true }]);

    expect(() => restoreQueriedTurn(raw, [RESULT])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("nested result accepts only appended unmarked plain text and restores host", () => {
    const host = { ...RESULT, content: [{ type: "text", text: "output" }] };

    const native = {
      ...host,
      content: [...host.content, { type: "text", text: "native note" }],
    };

    const restored = parse(restoreQueriedTurn(wire([native]), [host]));

    expect(restored.messages[1]?.content).toEqual([host]);
  });

  test.each([
    [[{ type: "text", text: "output" }, IMAGE]],
    [
      [
        {
          type: "text",
          text: "output",
          citations: [{ title: "host citation" }],
        },
      ],
    ],
  ])(
    "structured host content survives native trailing text %#",
    (hostContent: Block[]) => {
      const host = { ...RESULT, content: structuredClone(hostContent) };

      const native = {
        ...host,
        content: [
          ...structuredClone(hostContent),
          { type: "text", text: "native note" },
        ],
      };

      const restored = parse(restoreQueriedTurn(wire([native]), [host]));

      expect(restored.messages[1]?.content).toEqual([host]);
    },
  );

  test.each([
    [
      [
        { type: "text", text: "out" },
        { type: "text", text: "put" },
      ],
    ],
    ["output"],
  ])(
    "split host text restores original representation %#",
    (content: string | Block[]) => {
      const host = { ...RESULT, content };

      const native = {
        ...RESULT,
        content: [
          { type: "text", text: "o" },
          { type: "text", text: "utput native suffix" },
        ],
      };

      expect(
        parse(restoreQueriedTurn(wire([native]), [host])).messages[1]?.content,
      ).toEqual([host]);
    },
  );

  test("nested cache settings are retained on matched block", () => {
    const marker = { type: "ephemeral", ttl: "1h" };
    const host = { ...RESULT, content: [{ type: "text", text: "output" }] };

    const native = {
      ...host,
      content: [
        { type: "text", text: "output", cache_control: marker },
        { type: "text", text: "native suffix" },
      ],
    };

    const restored = parse(restoreQueriedTurn(wire([native]), [host]))
      .messages[1]?.content;

    expect(restored).toEqual([
      {
        ...host,
        content: [{ type: "text", text: "output", cache_control: marker }],
      },
    ]);
  });

  test("nested host cache settings survive appended plain text", () => {
    const content = [
      {
        type: "text",
        text: "output",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ];

    const host = { ...RESULT, content };

    const native = {
      ...host,
      content: [...content, { type: "text", text: "native suffix" }],
    };

    expect(
      parse(restoreQueriedTurn(wire([native]), [host])).messages[1]?.content,
    ).toEqual([host]);
  });

  test.each([
    [[{ type: "text", text: "out native insertion put" }]],
    [[{ type: "text", text: "output", unknown: "native metadata" }]],
    [[{ type: "text", text: "output", cache_control: { type: "ephemeral" } }]],
  ])(
    "protected or changed text cannot be flattened into host string %#",
    (nativeContent: Block[]) => {
      expect(() =>
        restoreQueriedTurn(wire([{ ...RESULT, content: nativeContent }]), [
          RESULT,
        ]),
      ).toThrow(QueriedTurnMismatch);
    },
  );

  test("native text inserted before nested media is rejected", () => {
    const host = {
      ...RESULT,
      content: [{ type: "text", text: "output" }, IMAGE],
    };

    const native = {
      ...host,
      content: [{ type: "text", text: "output native insertion" }, IMAGE],
    };

    expect(() => restoreQueriedTurn(wire([native]), [host])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("nested conflicting cache settings are rejected", () => {
    const host = {
      ...RESULT,
      content: [
        {
          type: "text",
          text: "output",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };

    const native = {
      ...RESULT,
      content: [
        {
          type: "text",
          text: "output",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
    };

    expect(() => restoreQueriedTurn(wire([native]), [host])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("mixed frame restores split and extended plain user text", () => {
    const host = [RESULT, { type: "text", text: "user words" }];

    const native = [
      RESULT,
      { type: "text", text: "user " },
      { type: "text", text: "words native note" },
    ];

    const restored = parse(restoreQueriedTurn(wire(native), host));

    expect(restored.messages[1]?.content).toEqual(host);
  });

  test.each([
    IMAGE,
    { type: "text", text: "note", cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: "note",
      citations: [{ type: "web_search_result_location" }],
    },
  ])(
    "nested non-plain or metadata text is not discarded %#",
    (extra: Block) => {
      const host = { ...RESULT, content: [{ type: "text", text: "output" }] };
      const native = { ...host, content: [...host.content, extra] };

      expect(() => restoreQueriedTurn(wire([native]), [host])).toThrow(
        QueriedTurnMismatch,
      );
    },
  );

  test("appended tool result is rejected", () => {
    const extra = {
      type: "tool_result",
      tool_use_id: "unexpected",
      content: "hidden",
    };

    expect(() => restoreQueriedTurn(wire([RESULT, extra]), [RESULT])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test("duplicate queried tool ids fail closed", () => {
    const duplicate = { ...RESULT, content: "second output" };

    expect(() =>
      restoreQueriedTurn(wire([RESULT, duplicate]), [RESULT, duplicate]),
    ).toThrow(QueriedTurnMismatch);
  });

  test("plain user frame is byte identical after successful match", () => {
    const question = { type: "text", text: "hello" };
    const raw = wire([question]);

    expect(restoreQueriedTurn(raw, [question])).toBe(raw);
  });

  test.each([
    [
      [RESULT],
      wire([
        RESULT,
        {
          type: "text",
          text: "note",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ]),
    ],
    [
      [RESULT],
      wire([
        RESULT,
        { type: "tool_result", tool_use_id: "extra", content: "extra" },
      ]),
    ],
    [[RESULT], wire([RESULT, IMAGE])],
    [[RESULT], wire([RESULT, { type: "text", text: "note", citations: [] }])],
    [[RESULT], wire([RESULT, { type: "text", text: "note", unknown: true }])],
    [[RESULT], wire([{ ...RESULT, is_error: true }])],
    [[RESULT], withErrorFlag("0")],
    [[RESULT], wire([{ ...RESULT, tool_use_id: "wrong" }])],
    [[RESULT], wire([{ ...RESULT, content: "changed" }])],
    [[RESULT], wire([RESULT, RESULT])],
    [[RESULT], wire([{ type: "text", text: "prepended" }, RESULT])],
    [
      [{ ...RESULT, content: [{ type: "text", text: "output" }] }],
      wire([
        {
          ...RESULT,
          content: [
            { type: "text", text: "output" },
            {
              type: "text",
              text: "note",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]),
    ],
    [
      [{ ...RESULT, cache_control: { type: "ephemeral", ttl: "1h" } }],
      wire([{ ...RESULT, cache_control: { type: "ephemeral", ttl: "5m" } }]),
    ],
  ])(
    "unprovable restoration forwards the native payload unchanged %#",
    async (queried: Block[], payload: string) => {
      const gate = new Admission(UPSTREAM, 5000, queried);

      try {
        const response = await post(gate, payload).catch(() => undefined);

        await response?.text().catch(() => undefined);
      } finally {
        await gate.close();
      }

      expect(gate.unrestored).toBe(UNRESTORED);
      expect(gate.failure).toBeUndefined();
      // Nothing is dropped or rewritten: native's own frame goes upstream (only a marker may move).
      expect(received).toHaveLength(1);
      expect(strip(parse(received[0] ?? ""))).toEqual(strip(parse(payload)));
    },
  );

  test("wire continuity across parallel rounds and admission recreation", async () => {
    // Fake native client: prove replay stability, not vendor cache savings.
    const history: Message[] = [
      { role: "user", content: "earlier prompt" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed", signature: "sig" },
          { type: "text", text: "earlier answer" },
        ],
      },
    ];

    for (const round of [0, 1]) {
      const queried = [
        { type: "tool_result", tool_use_id: `p${round}a`, content: "A" },
        { type: "tool_result", tool_use_id: `p${round}b`, content: "B" },
      ];

      const assistant: Message = {
        role: "assistant",
        content: [
          { type: "tool_use", id: `p${round}a`, name: "a", input: {} },
          { type: "tool_use", id: `p${round}b`, name: "b", input: {} },
        ],
      };

      const nativeResults = [
        ...queried.map((entry) => ({ ...entry })),
        { type: "text", text: "native date annotation" },
      ];

      const messages = [
        ...history,
        assistant,
        { role: "user", content: nativeResults },
      ];

      const { status } = await relay(
        JSON.stringify({ model: "fixture", messages }),
        queried,
      );

      expect(status).toBe(200);
    }

    expect(received).toHaveLength(2);

    for (const payload of received) {
      const body = parse(payload);
      const newest = blocksOf(body.messages.at(-1));

      expect(body.messages.slice(0, history.length)).toEqual(history);

      expect(newest).toEqual([
        {
          type: "tool_result",
          tool_use_id: newest[0]?.tool_use_id,
          content: "A",
        },
        {
          type: "tool_result",
          tool_use_id: newest[1]?.tool_use_id,
          content: "B",
        },
      ]);
    }
  });

  test("nested cache marker on discarded native text is rejected", () => {
    const host = { ...RESULT, content: [{ type: "text", text: "output" }] };

    const native = {
      ...host,
      content: [
        ...host.content,
        { type: "text", text: "note", cache_control: { type: "ephemeral" } },
      ],
    };

    expect(() => restoreQueriedTurn(wire([native]), [host])).toThrow(
      QueriedTurnMismatch,
    );
  });

  test.each([
    "\n<system-reminder>\n# userEmail\nsomeone@example.invalid\n</system-reminder>",
    "\nSession context: a wording no CLI has shipped yet",
    "\n\nToday's date is 2031-01-01.",
  ])(
    "restoration is anchored on host ids and content, not native wording %#",
    (annotation) => {
      const native = [{ ...RESULT, content: RESULT.content + annotation }];
      const restored = parse(restoreQueriedTurn(wire(native), [RESULT]));

      expect(restored.messages.at(-1)?.content).toEqual([RESULT]);
    },
  );
});

describe("one-shot (test_admission_one_shot.py)", () => {
  const MARKER = { type: "ephemeral", ttl: "1h" };

  const POLICY = [
    { type: "text", text: "You are Claude Code.", cache_control: MARKER },
    {
      type: "text",
      text: "Summarize the transcript in the next user message.",
      cache_control: MARKER,
    },
  ];

  const TOOLS: Tool[] = [
    {
      name: "mcp__hermes__probe",
      input_schema: { type: "object" },
      cache_control: MARKER,
    },
  ];

  const REMINDER = {
    type: "text",
    text: "<system-reminder>\n# userEmail\na@example.invalid\n</system-reminder>\n",
  };

  const FRAME = {
    type: "text",
    text: `<transcript>${" earlier turn".repeat(200)}</transcript>`,
  };

  test("message marks go and system and tools marks stay", () => {
    const sent: Body = {
      model: "m",
      system: POLICY,
      tools: TOOLS,
      messages: [
        { role: "user", content: [REMINDER, FRAME] },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "Today's date is 2026-10-16.",
              cache_control: MARKER,
            },
          ],
        },
      ],
    };

    const out = parse(dropMessageBreakpoints(JSON.stringify(sent)));

    expect(
      out.messages
        .flatMap(blocksOf)
        .filter((entry) => "cache_control" in entry),
    ).toEqual([]);
    expect(out.system).toEqual(POLICY);
    expect(out.tools).toEqual(TOOLS);

    const unmarked = (body: Body) =>
      body.messages.map((item) => blocksOf(item).map(unmarkedBlock));

    expect(unmarked(out)).toEqual(unmarked(sent));
  });

  test("a payload without message marks forwards byte identical", () => {
    const raw = JSON.stringify({
      model: "m",
      system: POLICY,
      messages: [{ role: "user", content: [FRAME] }],
    });

    expect(dropMessageBreakpoints(raw)).toBe(raw);
  });

  test("a payload that does not parse forwards as is", () => {
    for (const raw of ["not json", JSON.stringify({ model: "m" })])
      expect(dropMessageBreakpoints(raw)).toBe(raw);
  });
});

describe("tool streaming (test_admission_tool_streaming.py)", () => {
  const TOOLS: Tool[] = [
    { name: "mcp__hermes__write_file", input_schema: { type: "object" } },
    {
      name: "mcp__hermes__read_file",
      input_schema: { type: "object" },
      eager_input_streaming: false,
    },
  ];

  test("every tool asks for streamed arguments and native values win", () => {
    const out = parse(
      streamToolInput(
        JSON.stringify({ model: "m", tools: TOOLS, messages: [] }),
      ),
    );

    expect(out.tools).toEqual([
      ...TOOLS.slice(0, 1).map((tool) => ({
        ...tool,
        eager_input_streaming: true,
      })),
      ...TOOLS.slice(1),
    ]);
  });

  test("requests without tools or unparseable forward byte identical", () => {
    for (const raw of [
      JSON.stringify({ model: "m", messages: [] }),
      "not json",
      JSON.stringify({ model: "m", tools: [{ ...TOOLS[1] }], messages: [] }),
    ])
      expect(streamToolInput(raw)).toBe(raw);
  });

  test("a tool call cut off mid-argument is dropped and the stream still captures", () => {
    // Streamed input is unvalidated: a max_tokens cut leaves partial JSON. The relay must keep going and must
    // never hand the host a call with guessed arguments.
    const capture = new Capture();

    capture.feed(
      sse(
        {
          type: "message_start",
          message: {
            id: "m",
            role: "assistant",
            content: [],
            usage: { input_tokens: 1 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Writing it." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t", name: "w", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path": "a.md", "content": "trunc',
          },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 9 },
        },
        { type: "message_stop" },
      ),
    );

    expect(capture.complete).toBe(true);
    expect(capture.message?.content).toEqual([
      { type: "text", text: "Writing it." },
    ]);
    expect(capture.message?.stop_reason).toBe("max_tokens");
  });
});

function sse<T>(...events: T[]) {
  return new TextEncoder().encode(
    events
      .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}

describe("admission", () => {
  const ASK = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });

  test("forwards exactly one request and denies the rest", async () => {
    const gate = new Admission(UPSTREAM, 5000);

    try {
      const first = await post(gate, ASK);

      await first.text();

      const second = await post(gate, ASK);
      const denial = await second.json();

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(denial.error.type).toBe("invalid_request_error");
      expect(gate.used).toBe(true);
      expect(gate.denied).toBe(1);
      expect(gate.status).toBe(200);
      expect(received).toEqual([ASK]);
    } finally {
      await gate.close();
    }
  });

  test("captures the streamed assistant message", async () => {
    const stream = sse(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "fixture",
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " there" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t", name: "probe", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"lane":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: ' "a"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    );

    respond = () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const { gate, status, text } = await relay(ASK, undefined);

    expect(status).toBe(200);
    expect(text).toBe(new TextDecoder().decode(stream));
    expect(gate.failure).toBeUndefined();
    expect(gate.capture.complete).toBe(true);

    expect(gate.capture.message).toEqual({
      id: "msg_1",
      role: "assistant",
      model: "fixture",
      content: [
        { type: "text", text: "Hello there" },
        { type: "tool_use", id: "t", name: "probe", input: { lane: "a" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 7 },
    });
  });

  test("keeps the upstream's error message for a non-200 answer", async () => {
    const error = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long" },
    });

    respond = () =>
      new Response(error, {
        status: 400,
        headers: { "content-type": "application/json", "request-id": "req_1" },
      });

    const { gate, status, text } = await relay(ASK, undefined);

    expect(status).toBe(400);
    expect(text).toBe(error);
    expect(gate.status).toBe(400);
    expect(gate.requestId).toBe("req_1");
    expect(gate.errorText()).toBe("prompt is too long");
    expect(gate.capture.message).toBeUndefined();
  });

  test.each([
    ["an Origin header", { origin: "https://example.com" }, "/v1/messages"],
    ["a wrong path", {}, "/v1/other"],
  ])(
    "answers %s with 404 and keeps the admission unused",
    async (_, headers: Record<string, string>, path: string) => {
      const gate = new Admission(UPSTREAM, 5000);

      try {
        const response = await post(gate, ASK, headers, path);

        await response.text();

        expect(response.status).toBe(404);
        expect(gate.used).toBe(false);
        expect(gate.denied).toBe(0);
        expect(received).toEqual([]);
      } finally {
        await gate.close();
      }
    },
  );
});
