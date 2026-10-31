import { play, sounds, themes, type ThemeName } from "cuelume";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Section, SettingRow, WorkspacePage } from "@/components/workspace";
import { type NoticeKind, notifications, playNotice } from "@/lib/live";

const NOTICES: { kind: NoticeKind; label: string }[] = [
  { kind: "reply", label: "Reply" },
  { kind: "approval", label: "Approval" },
  { kind: "credential", label: "Credential or login" },
];

/** Shows a notice of `kind` as the browser would, with its sound when sound is on. */
function testNotice(kind: NoticeKind, label: string) {
  if (notifications.sound()) playNotice(kind);

  if (notifications.permission() === "granted")
    new Notification(`Crumble · ${label}`, {
      body: "A test notification.",
      icon: "/ui/icon-192.png",
      requireInteraction: kind !== "reply",
      silent: notifications.sound(),
    });
}

/** A page outside the navigation for hearing the notification sounds and every cue. */
export function SoundsPage() {
  const [theme, setTheme] = useState<ThemeName>("default");

  return (
    <WorkspacePage title="Sounds">
      <Section title="Notifications">
        {NOTICES.map(({ kind, label }) => (
          <SettingRow key={kind} title={label}>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => playNotice(kind)}>
                Play
              </Button>
              <Button variant="outline" onClick={() => testNotice(kind, label)}>
                Notify
              </Button>
            </div>
          </SettingRow>
        ))}
      </Section>
      <Section
        title="Cues"
        action={
          <div className="flex gap-1">
            {themes.map((name) => (
              <Button
                key={name}
                size="sm"
                variant={name === theme ? "secondary" : "ghost"}
                onClick={() => setTheme(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap gap-2 p-4">
          {sounds.map((name) => (
            <Button
              key={name}
              variant="outline"
              onClick={() => play(name, { theme })}
            >
              {name}
            </Button>
          ))}
        </div>
      </Section>
    </WorkspacePage>
  );
}
