import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type { DesktopShell } from "../../src/bot-desktop/computer-use";
import { DRIVER_ARGS } from "../../src/bot-desktop/computer-use-driver";

const jsonObject = z.record(z.string(), z.json());

export type GuestReply = z.infer<typeof jsonObject>;

export type GuestCall = { tool: string; args: GuestReply };

const CALL = new RegExp(
  `printf '%s' "\\$${DRIVER_ARGS}" \\| cua-driver call (\\w+)( --screenshot-out-file (\\S+))?$`,
);

/**
 * A bot desktop that runs only cua-driver and xdotool, answering each cua-driver tool from a queue of scripted replies.
 * The last reply of a queue repeats. The focused window is 101. Screenshots convert to JPEG unless `failConvert` is set.
 * `commands` and `writes` record every command line and file written, so tests can check what a value reached.
 */
type CommandIo = {
  out: (output: string) => void;
  env: Record<string, string> | undefined;
};

export function scriptedGuest(replies: Record<string, GuestReply[]>) {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestCall[] = [];
  const commands: string[] = [];
  const writes: string[] = [];

  const state = {
    failConvert: false,
    processStart: "Thu Oct 30 10:00:00 2026",
  };

  const shell: DesktopShell = {
    async writeFile(path, content) {
      files.set(path, content);
      writes.push(path);

      return { ok: true, value: undefined };
    },
    async readBinaryFile(path) {
      const content = files.get(path);

      return content instanceof Uint8Array
        ? { ok: true, value: content }
        : { ok: false, error: new FileError("not_found", `no ${path}`, path) };
    },
    async exec(command, options) {
      const text = Array.isArray(command) ? command.join(" ") : String(command);

      commands.push(text);

      const io: CommandIo = {
        out: (output) =>
          options?.onOutput?.(output, BACKGROUND_CONTEXT, { stream: "stdout" }),
        env: options?.env,
      };

      for (const [pattern, run] of handlers) {
        const match = pattern.exec(text);

        if (match) return { ok: true, value: { exitCode: run(match, io) } };
      }

      return {
        ok: false,
        error: new ExecutionError("unknown", `unexpected command: ${text}`),
      };
    },
  };

  const convert = ([, png = "", jpg = ""]: RegExpExecArray) => {
    if (state.failConvert || !files.has(png)) return 1;

    files.set(jpg, new Uint8Array([0xff, 0xd8, 0xff]));

    return 0;
  };

  const remove = ([, paths = ""]: RegExpExecArray) => {
    for (const path of paths.split(" ")) files.delete(path);

    return 0;
  };

  const activeWindow = (_: RegExpExecArray, io: CommandIo) => {
    io.out("101\n");

    return 0;
  };

  // `state.processStart` is when every process started; a test changes it to restart Chromium.
  const processStart = (_: RegExpExecArray, io: CommandIo) => {
    io.out(`${state.processStart}\n`);

    return 0;
  };

  const driverCall = (
    [, tool = "", , screenshot]: RegExpExecArray,
    io: CommandIo,
  ) => {
    calls.push({
      tool,
      args: jsonObject.parse(JSON.parse(io.env?.[DRIVER_ARGS] ?? "{}")),
    });

    const queue = replies[tool] ?? [];

    if (screenshot) files.set(screenshot, new Uint8Array([0x89, 0x50]));

    io.out(JSON.stringify((queue.length > 1 ? queue.shift() : queue[0]) ?? {}));

    return 0;
  };

  const handlers: [
    RegExp,
    (match: RegExpExecArray, io: CommandIo) => number,
  ][] = [
    [/^convert (\S+) -quality 75 (\S+)$/, convert],
    [/^rm -f (.*)$/, remove],
    [/xdotool getactivewindow/, activeWindow],
    [/ps -o lstart= -p \d+$/, processStart],
    [CALL, driverCall],
  ];

  return { shell, calls, commands, writes, files, state };
}
