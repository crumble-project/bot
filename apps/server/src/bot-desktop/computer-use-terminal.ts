import type { Context } from "@earendil-works/chord";
import type { ComputerUseResult } from "./computer-use";
import { sh, type Window } from "./computer-use-driver";
import { textResult, type ComputerUseState } from "./computer-use-state";

/** Terminal emulators: Enter runs a shell command in the bot's own workspace, and the tree holds none of their text. */
const TERMINAL_APP = /terminal|xterm|konsole|alacritty|kitty/i;

export const isTerminal = (window: Window | undefined) =>
  TERMINAL_APP.test(window?.app_name ?? "");

/** The terminal's text from its end; a long scrollback would crowd out the job's context. */
const TAIL_CHARS = 6000;

/**
 * A terminal's text, which its accessibility tree doesn't expose: select all and copy in the terminal, then read the
 * clipboard. It replaces the clipboard's content.
 */
export async function terminalText(
  state: ComputerUseState,
  window: Window,
  context: Context,
) {
  const text = await sh(
    state.shell,
    `xdotool windowactivate --sync ${window.window_id} key --clearmodifiers ctrl+shift+a ctrl+shift+c && sleep 0.3 && xclip -o -selection clipboard | tail -c ${TAIL_CHARS}`,
    context,
  );

  // Only line breaks go: a space at the end of the prompt line belongs to the command being typed.
  return text.replace(/\n+$/, "");
}

export async function readTerminal(
  state: ComputerUseState,
  window: Window,
  context: Context,
): Promise<ComputerUseResult> {
  return textResult(
    `terminal ${window.window_id} "${window.title}" text, latest last:\n${(await terminalText(state, window, context)).trimEnd()}`,
  );
}
