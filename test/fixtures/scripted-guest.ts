import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type { DesktopShell } from "../../src/computer-use";

const jsonObject = z.record(z.string(), z.json());

export type GuestReply = z.infer<typeof jsonObject>;

export type GuestCall = { tool: string; args: GuestReply };

const CALL =
  /cua-driver call (\w+)( --screenshot-out-file (\S+))? "\$\(cat (\S+)\)"/;

/**
 * A bot desktop that runs only cua-driver and xdotool, answering each cua-driver tool from a queue of scripted replies.
 * The last reply of a queue repeats. The focused window is 101.
 */
export function scriptedGuest(replies: Record<string, GuestReply[]>) {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestCall[] = [];

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

      // The tool converts the screenshot to JPEG next to it.
      if (screenshot)
        files.set(
          screenshot.replace(/\.png$/, ".jpg"),
          new Uint8Array([0xff, 0xd8, 0xff]),
        );

      out(JSON.stringify(reply));

      return { ok: true, value: { exitCode: 0 } };
    },
  };

  return { shell, calls };
}
