import { SmoothCorners } from "@lisse/react";
import { css } from "styled-system/css";
import { useColorScheme } from "~/color-scheme";

type Message = { date: string; label: string; sender: string; text: string };

const messages: Message[] = [
  {
    date: "2026-03-04",
    label: "Mar 4",
    sender: "You",
    text: "Remind me to renew the domain before it runs out.",
  },
  {
    date: "2026-03-04",
    label: "Mar 4",
    sender: "Juniper",
    text: "Done. I’ll bring it up on October 20.",
  },
  {
    date: "2026-10-20",
    label: "Oct 20",
    sender: "Juniper",
    text: "The domain expires in four days. Should I open the registrar on my desktop and renew it?",
  },
  {
    date: "2026-10-20",
    label: "Oct 20",
    sender: "You",
    text: "Yes, one year.",
  },
];

const figure = css({
  my: "2.25em!",
  px: "1.25rem",
  py: "1rem",
  bg: "card",
  border: "1px solid",
  borderColor: "border",
  fontSize: ".9375rem",
  lineHeight: "1.55",
});

const row = css({
  display: "grid",
  gridTemplateColumns: { base: "3.5rem 1fr", sm: "4rem 4.5rem 1fr" },
  columnGap: ".75rem",
  "& + &": { mt: ".6em" },
});

// The gap between March and October is the point: one chat, months apart.
const gap = css({ mt: "1.6em!" });

const time = css({ color: "faint", fontVariantNumeric: "tabular-nums" });

const text = css({ gridColumn: { base: "2", sm: "auto" } });

export function Transcript() {
  const scheme = useColorScheme();

  return (
    <SmoothCorners
      key={scheme}
      as="figure"
      corners={{ radius: 14, smoothing: 0.6 }}
      className={figure}
      aria-label="Excerpt from a bot chat"
    >
      <ol>
        {messages.map((message, index) => (
          <li
            key={`${message.date}-${message.sender}`}
            className={
              index > 0 && message.date !== messages[index - 1].date
                ? `${row} ${gap}`
                : row
            }
          >
            <time dateTime={message.date} className={time}>
              {message.label}
            </time>
            <b>{message.sender}</b>
            <span className={text}>{message.text}</span>
          </li>
        ))}
      </ol>
    </SmoothCorners>
  );
}
