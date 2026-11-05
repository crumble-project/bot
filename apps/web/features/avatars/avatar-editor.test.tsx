import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import {
  defaultAvatarDefinition,
  type BotAvatarDefinition,
} from "@crumble/server/contract/avatar";

test("gallery, import validation, colors and description-inclusive generation prompt", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });

  const values = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { AvatarEditor } = await import("./avatar-editor");

  const original = defaultAvatarDefinition("studio");

  let current: BotAvatarDefinition = original;

  function Editor() {
    const [value, setValue] = useState(original);

    return (
      <AvatarEditor
        value={value}
        onChange={(next) => {
          current = next;
          setValue(next);
        }}
      />
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const click = async (label: string) =>
    act(async () => {
      const button = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find(
        (each) =>
          each.textContent === label ||
          each.getAttribute("aria-label") === label,
      );

      if (!button) throw new Error(`Missing button ${label}`);
      button.click();
    });

  const type = async (selector: string, value: string) =>
    act(async () => {
      const field = container.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(selector)!;

      const prototype =
        field.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;

      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

  try {
    await act(async () => root.render(<Editor />));
    await click("Pick Mug");
    expect(current.definition.id).toBe("mug");
    await type('input[id$="-body"]', "#123456");
    await type('input[id$="-eyes"]', "#fedcba");
    expect(current.color).toBe("#123456");
    expect(current.eyeColor).toBe("#fedcba");
    await click("Generate");
    await type("textarea", "A watering can for my garden");
    await click("Copy generation prompt");
    expect(copied).toContain("# Avatar geometry designer");
    expect(copied).toContain(
      "## User description\n\nA watering can for my garden",
    );
    await click("Import");
    const before = current;
    await type("textarea", "not JSON");
    await click("Validate and import");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(current).toBe(before);
    await type(
      "textarea",
      JSON.stringify({
        ...original.definition,
        eyes: { x: 0, y: 0, spacing: 16, scale: 1 },
      }),
    );
    await click("Validate and import");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "eyes must sit inside the body",
    );
    expect(current).toBe(before);
    await type(
      "textarea",
      JSON.stringify({ ...original.definition, body: { path: "" } }),
    );
    await click("Validate and import");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(current).toBe(before);
    await type("textarea", JSON.stringify(original.definition));
    await click("Validate and import");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(current.definition.id).toBe(original.definition.id);
    expect(current.color).toBe("#123456");
    expect(current.eyeColor).toBe("#fedcba");
  } finally {
    await act(async () => root.unmount());

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    await window.happyDOM.close();
  }
});
