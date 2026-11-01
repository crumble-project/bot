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
        <strong>Crumble.</strong> Self-hosted bots that work in their own Linux
        desktop and{" "}
        <Highlight options={highlight[scheme]}>
          ask before anything they can’t undo
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
        memories, and skills. You talk to it in the{" "}
        <a href={`${docs}/clients/web`}>web app</a> or on{" "}
        <a href={`${docs}/concepts/discord`}>Discord</a>.
      </p>

      <Transcript />

      <p>
        When a task needs real tools, a bot starts a{" "}
        <a href={`${docs}/concepts/workspaces`}>coding job</a> or a desktop job
        in its own Linux workspace. Before it clicks Pay or Send, it checks that
        you asked. You can watch its desktop or take control.
      </p>

      <p>
        Bots run{" "}
        <a href={`${docs}/concepts/schedules-and-integrations`}>automations</a>{" "}
        on a schedule or when a webhook arrives, hand work to each other, and
        use your <a href={`${docs}/concepts/logins`}>logins</a> without seeing
        them. Every change they make to their own skills and memory can be
        undone.
      </p>

      <p>
        You run one server. Bring an API key, or use the ChatGPT, Claude, or
        Copilot plan you already pay for. Everything stays on your server.
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
