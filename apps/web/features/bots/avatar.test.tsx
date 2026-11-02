import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { legacyAvatarDefinition } from "@crumble/server/contract/avatar";

test("static and live avatars update geometry, moods and colors, stop sleeping, and honor reduced motion", async () => {
  const window = new Window();
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const frames = new Map<number, FrameRequestCallback>();
  const changes = new Set<() => void>();

  const media = {
    matches: false,
    addEventListener: (_: string, fn: () => void) => changes.add(fn),
  };

  let nextFrame = 0;

  const values = {
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: () => media,
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      frames.set(++nextFrame, fn);

      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { BotAvatar } = await import("./avatar");
  const container = document.createElement("div");
  const root = createRoot(container);

  const look = legacyAvatarDefinition({
    id: "test",
    avatar: "bot:test;silhouette=cloud;color=#38bdf8",
  });

  const bot = { id: "test", avatar: "bot:unchanged", avatarDefinition: look };

  const tick = async () =>
    act(async () => {
      const pending = [...frames.values()];
      frames.clear();

      for (const fn of pending) fn(performance.now());
    });

  try {
    await act(async () => root.render(<BotAvatar bot={bot} />));
    const idle = container.querySelector("img")!.src;
    expect(decodeURIComponent(idle)).toContain("<path");
    expect(decodeURIComponent(idle)).toContain("#38bdf8");
    expect(frames.size).toBe(0);
    await act(async () => root.render(<BotAvatar bot={bot} state="working" />));
    expect(container.querySelector("img")!.src).not.toBe(idle);
    await act(async () => root.render(<BotAvatar bot={bot} live />));
    await tick();
    expect(container.querySelector("[data-avatar-scene]")).not.toBeNull();
    expect(frames.size).toBe(1);
    const neutral = container.innerHTML;
    await act(async () =>
      root.render(<BotAvatar bot={bot} live state="working" />),
    );
    await tick();
    expect(container.innerHTML).not.toBe(neutral);
    expect(container.querySelector('[data-state="working"]')).not.toBeNull();
    media.matches = true;

    for (const fn of changes) fn();

    for (let i = 0; i < 4 && frames.size; i++) await tick();
    expect(frames.size).toBe(0);
    const reduced = container.innerHTML;
    await tick();
    expect(container.innerHTML).toBe(reduced);
    media.matches = false;

    for (const fn of changes) fn();
    await tick();
    expect(frames.size).toBe(1);
    await act(async () =>
      root.render(<BotAvatar bot={bot} live state="sleeping" />),
    );
    expect(container.querySelector("[data-avatar-scene]")).toBeNull();
    expect(container.querySelector("img")!.src).toBe(idle);
    expect(
      container.querySelector<HTMLElement>("[data-state]")!.style.opacity,
    ).toBe("0.45");
    expect(frames.size).toBe(0);

    const next = {
      ...bot,
      avatarDefinition: {
        ...legacyAvatarDefinition({
          id: "other",
          avatar: "bot:other;silhouette=hexagon",
        }),
        color: "#abc",
        eyeColor: "#def",
      },
    };

    await act(async () => root.render(<BotAvatar bot={next} />));
    expect(container.querySelector("img")!.src).not.toBe(idle);
    expect(decodeURIComponent(container.querySelector("img")!.src)).toContain(
      "#aabbcc",
    );
    expect(decodeURIComponent(container.querySelector("img")!.src)).toContain(
      "#ddeeff",
    );
    await act(async () =>
      root.render(
        <BotAvatar bot={{ id: "older-server", avatar: "critters:old" }} />,
      ),
    );
    expect(decodeURIComponent(container.querySelector("img")!.src)).toContain(
      "<path",
    );
  } finally {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    await window.happyDOM.close();
  }
});
