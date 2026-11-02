import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  DocumentReader,
  PromptSection,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { WORKSPACE_PATH } from "../workspaces/workspace";

/** The workspace notes, relative to the workspace: the bot and every job of it read them in their prompts. */
export const WORKSPACE_NOTES_FILE = ".crumble/notes.md";

/** Notes past this many bytes are cut, so a runaway file can't crowd out the job's prompt. */
export const WORKSPACE_NOTES_MAX_BYTES = 4096;

export const WORKSPACE_NOTES_SECTION = "workspace_notes";

/** The bot's own workspace section, in its chat and group chats; job sections use other keys, which it must not shadow. */
export const WORKSPACE_SECTION = "workspace";

const NOTES_PATH = `${WORKSPACE_PATH}/${WORKSPACE_NOTES_FILE}`;

const CUT_MARKER = `[Cut: the notes are over ${WORKSPACE_NOTES_MAX_BYTES / 1024} KB.]`;

const UPDATE =
  "When you learn something a later job would otherwise rediscover, such as a tool installed outside the workspace and how to install it again, a command that needs a flag or environment variable, where a clone lives and how to run its checks, or a server left running and its start command, write it in the notes. " +
  `Keep them short and under ${WORKSPACE_NOTES_MAX_BYTES / 1024} KB: replace stale lines instead of adding to them, and never write secrets in them.`;

/** The notes' text, cut at the last whole line within the limit; undefined when there are none. */
export async function readWorkspaceNotes(
  env: ExecutionEnv,
  context: Context,
): Promise<string | undefined> {
  const opened = await env.openBinaryReader(
    WORKSPACE_NOTES_FILE,
    undefined,
    context,
  );

  if (!opened.ok) {
    if (opened.error.code === "not_found") return undefined;
    throw opened.error;
  }

  try {
    const bytes = await opened.value.read(
      0,
      WORKSPACE_NOTES_MAX_BYTES + 1,
      context,
    );

    if (!bytes.ok) throw bytes.error;

    if (bytes.value.length <= WORKSPACE_NOTES_MAX_BYTES) {
      const text = new TextDecoder().decode(bytes.value).trim();

      return text || undefined;
    }

    const head = new TextDecoder().decode(
      bytes.value.subarray(0, WORKSPACE_NOTES_MAX_BYTES),
    );

    const lineEnd = head.lastIndexOf("\n");

    return `${(lineEnd > 0 ? head.slice(0, lineEnd) : head).trimEnd()}\n${CUT_MARKER}`;
  } finally {
    await opened.value.close(context);
  }
}

/**
 * The workspace notes in a job's prompt. `writable` jobs are told to keep them current. Installed job extensions render
 * in the bot's chat too, where `chatWorkspaceSection` shows the notes instead: there this reads and renders nothing.
 */
export const workspaceNotesSection = (
  isJob: (
    reader: DocumentReader,
    conversationId: ConversationId,
    context: Context,
  ) => Promise<boolean>,
  writable: boolean,
): PromptSection => ({
  key: WORKSPACE_NOTES_SECTION,
  render: async (input, context) => {
    if (!input.env || !(await isJob(input.read, input.conversationId, context)))
      return undefined;

    const notes = await readWorkspaceNotes(input.env, context);

    if (!writable)
      return notes
        ? `Facts earlier jobs of this bot learned about this workspace:\n${notes}`
        : undefined;

    return notes
      ? `Facts earlier jobs of this bot learned about this workspace, kept in ${NOTES_PATH}. Use them instead of rediscovering, and fix a line that proves wrong.\n${notes}\n${UPDATE}`
      : `No notes yet: jobs of this bot keep facts about this workspace in ${NOTES_PATH}. ${UPDATE}`;
  },
});

const SERVERS = `To leave a server or other long-running program running, start it in its own session with its output in a log file: setsid <command> > ${WORKSPACE_PATH}/<name>.log 2>&1 < /dev/null &.`;

/**
 * The workspace in the bot's own conversations. Rendering never boots the machine: the notes show only while it runs,
 * and otherwise a pointer to them does.
 */
export const chatWorkspaceSection = (
  running: () => boolean,
): PromptSection => ({
  key: WORKSPACE_SECTION,
  render: async (input, context) => {
    const intro = `You work in your workspace, ${WORKSPACE_PATH}, with read, write, edit, and bash. It persists and your coding jobs share it. ${SERVERS}`;

    if (!input.env || !running())
      return `${intro}\nIts notes are in ${NOTES_PATH}: read them before you work there.`;

    const notes = await readWorkspaceNotes(input.env, context);

    return notes
      ? `${intro}\nFacts you and your jobs learned about this workspace, kept in ${NOTES_PATH}. Use them instead of rediscovering, and fix a line that proves wrong.\n${notes}\n${UPDATE}`
      : `${intro}\nNo notes yet: you and your jobs keep facts about this workspace in ${NOTES_PATH}. ${UPDATE}`;
  },
});
