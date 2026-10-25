import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type { DesktopShell } from "../../src/bot-desktop/computer-use";

const jsonObject = z.record(z.string(), z.json());

export type GuestReply = z.infer<typeof jsonObject>;

export type GuestCall = { tool: string; args: GuestReply };

const CALL =
  /cua-driver call (\w+)( --screenshot-out-file (\S+))? "\$\(cat (\S+)\)"/;

/**
 * A bot desktop that runs only cua-driver and xdotool, answering each cua-driver tool from a queue of scripted replies.
 * The last reply of a queue repeats. The focused window is 101. Screenshots convert to JPEG unless `failConvert` is set.
 */
export function scriptedGuest(replies: Record<string, GuestReply[]>) {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestCall[] = [];
  const state = { failConvert: false };

  const shell: DesktopShell = {
    async writeFile(path, content) {
      files.set(path, content);

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

      const out = (output: string) =>
        options?.onOutput?.(output, BACKGROUND_CONTEXT, { stream: "stdout" });

      const convert = /^convert (\S+) -quality 75 (\S+)$/.exec(text);

      if (convert) {
        const [, png = "", jpg = ""] = convert;

        if (state.failConvert || !files.has(png))
          return { ok: true, value: { exitCode: 1 } };

        files.set(jpg, new Uint8Array([0xff, 0xd8, 0xff]));

        return { ok: true, value: { exitCode: 0 } };
      }

      if (text.startsWith("rm -f ")) {
        for (const path of text.slice("rm -f ".length).split(" "))
          files.delete(path);

        return { ok: true, value: { exitCode: 0 } };
      }

      if (text.includes("xdotool getactivewindow")) {
        out("101\n");

        return { ok: true, value: { exitCode: 0 } };
      }

      const match = CALL.exec(text);

      if (!match)
        return {
          ok: false,
          error: new ExecutionError("unknown", `unexpected command: ${text}`),
        };

      const [, tool = "", , screenshot, argsFile = ""] = match;

      const args = jsonObject.parse(JSON.parse(String(files.get(argsFile))));

      calls.push({ tool, args });

      const queue = replies[tool] ?? [];
      const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};

      if (screenshot) files.set(screenshot, new Uint8Array([0x89, 0x50]));

      // The tool removes its arguments file in the same command.
      files.delete(argsFile);

      out(JSON.stringify(reply));

      return { ok: true, value: { exitCode: 0 } };
    },
  };

  return { shell, calls, files, state };
}
