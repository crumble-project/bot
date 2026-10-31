import { Highlight } from "@highlighters/react";
import { SmoothCorners } from "@lisse/react";
import { createFileRoute } from "@tanstack/react-router";
import { css } from "styled-system/css";
import { useColorScheme } from "~/color-scheme";
import { Transcript } from "~/components/Transcript";

export const Route = createFileRoute("/")({ component: Home });

const docs = "https://docs.crumbli.ng";

const highlight = {
  light: { color: "#A8E2C0" },
  dark: { color: "#346552", blendMode: "screen" },
} as const;

const main = css({
  "& > * + *": { mt: "1.65em" },
  "& a": { _hover: { color: "mark" } },
});

function Home() {
  const scheme = useColorScheme();

  return (
    <main className={main}>
      <p>
        <strong>Crumble.</strong> Self-hosted bots with their own identity,
        memory, and{" "}
        <Highlight options={highlight[scheme]}>
          one continuous chat with you
        </Highlight>
        .
      </p>

      <figure>
        <SmoothCorners
          key={scheme}
          asChild
          corners={{ radius: 14, smoothing: 0.6 }}
        >
          <img
            className={css({
              display: "block",
              w: "full",
              h: "auto",
              border: "1px solid",
              borderColor: "border",
            })}
            src="/screenshot.webp"
            width={2000}
            height={1096}
            alt="The Crumble web app with a chat open to a bot named Otis"
          />
        </SmoothCorners>
      </figure>

      <p>
        Each <a href={`${docs}/concepts`}>bot</a> has a name, instructions,
        memories, skills, and scheduled tasks. You talk to it in a single{" "}
        <a href={`${docs}/concepts/chats`}>chat</a> that never resets. Older
        context gets summarized for the bot, and the full transcript stays with
        you.
      </p>

      <Transcript />

      <p>
        When a task needs real tools, a bot starts a{" "}
        <a href={`${docs}/concepts/workspaces`}>coding job</a> or a desktop job
        in its own Linux workspace, and the answer comes back to the chat. You
        can watch its desktop or take control.
      </p>

      <p>
        Bots refine their own skills and memory as they work. Every change
        records where it came from, and you can undo it.
      </p>

      <p>
        You run one server and chat from the{" "}
        <a href={`${docs}/clients/web`}>web app</a>. Bring an API key or sign in
        with a provider account.
      </p>

      <p>
        <a href={`${docs}/getting-started/server`}>Run the server</a>, read the{" "}
        <a href={docs}>docs</a>, or browse the code on{" "}
        <a href="https://github.com/crumble-project">GitHub</a>.
      </p>

      <p>C:</p>
    </main>
  );
}
