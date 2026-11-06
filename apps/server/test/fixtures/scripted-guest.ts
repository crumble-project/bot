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

type CommandIo = {
  out: (output: string) => void;
  env: Record<string, string> | undefined;
};

type GuestState = {
  failConvert: boolean;
  failCapture: boolean;
  processStart: string;
  terminalText: string;
};

type Guest = {
  files: Map<string, Uint8Array | string>;
  calls: GuestCall[];
  replies: Record<string, GuestReply[]>;
  state: GuestState;
};

type GuestCommand = (
  guest: Guest,
  match: RegExpExecArray,
  io: CommandIo,
) => number;

const convert: GuestCommand = ({ files, state }, [, png = "", jpg = ""]) => {
  if (state.failConvert || !files.has(png)) return 1;

  files.set(jpg, new Uint8Array([0xff, 0xd8, 0xff]));

  return 0;
};

const captureScreen: GuestCommand = ({ files, state }, [, jpg = ""], io) => {
  if (state.failCapture) {
    io.out("import: unable to open X server `:1'\n");

    return 1;
  }

  files.set(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  io.out("ok\n");

  return 0;
};

const remove: GuestCommand = ({ files }, [, paths = ""]) => {
  for (const path of paths.split(" ")) files.delete(path);

  return 0;
};

const activeWindow: GuestCommand = (_guest, _match, io) => {
  io.out("101\n");

  return 0;
};

const processStart: GuestCommand = ({ state }, _match, io) => {
  io.out(`${state.processStart}\n`);

  return 0;
};

const readClipboard: GuestCommand = ({ state }, _match, io) => {
  io.out(state.terminalText);

  return 0;
};

const driverCall: GuestCommand = (
  { files, calls, replies },
  [, tool = "", , screenshot],
  io,
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

const GUEST_COMMANDS: [RegExp, GuestCommand][] = [
  [/^convert (\S+) -quality 75 (\S+)$/, convert],
  [/import -window root -quality 75 (\S+) 2>&1 && echo ok$/, captureScreen],
  [/^rm -f (.*)$/, remove],
  [/xdotool getactivewindow/, activeWindow],
  [/ps -o lstart= -p \d+$/, processStart],
  [/xclip -o -selection clipboard/, readClipboard],
  [/setsid .* >\/dev\/null 2>&1 <\/dev\/null &$/, () => 0],
  [CALL, driverCall],
];

export function scriptedGuest(replies: Record<string, GuestReply[]>) {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestCall[] = [];
  const commands: string[] = [];
  const writes: string[] = [];

  const state: GuestState = {
    failConvert: false,
    failCapture: false,
    processStart: "Thu Oct 30 10:00:00 2026",
    terminalText: "",
  };

  const guest: Guest = { files, calls, replies, state };

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

      for (const [pattern, run] of GUEST_COMMANDS) {
        const match = pattern.exec(text);

        if (match)
          return { ok: true, value: { exitCode: run(guest, match, io) } };
      }

      return {
        ok: false,
        error: new ExecutionError("unknown", `unexpected command: ${text}`),
      };
    },
  };

  return { shell, calls, commands, writes, files, state };
}
