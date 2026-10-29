import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotAvatar } from "./avatar";
import { BotPainter } from "./bot-avatar";

for (const reduced of [false, true]) {
  test(`redraws state changes when ${reduced ? "motion is reduced" : "animation is disabled"}`, async () => {
    const window = new Window();
    const globals = Object.getOwnPropertyDescriptors(globalThis);

    Object.defineProperties(globalThis, {
      window: { configurable: true, value: window },
      document: { configurable: true, value: window.document },
      devicePixelRatio: { configurable: true, value: 1 },
      Path2D: {
        configurable: true,
        value: class {
          moveTo() {}
          ellipse() {}
          roundRect() {}
          lineTo() {}
          closePath() {}
          bezierCurveTo() {}
        },
      },
      matchMedia: { configurable: true, value: () => ({ matches: reduced }) },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    });

    const context = { setTransform() {} };

    // SAFETY: The paint spy prevents access to canvas methods other than setTransform.
    const getContext = spyOn(
      window.HTMLCanvasElement.prototype,
      "getContext",
    ).mockReturnValue(context as never);

    const paint = spyOn(BotPainter.prototype, "paint").mockImplementation(
      () => {},
    );

    const root = createRoot(document.createElement("div"));
    const bot = { id: "test", avatar: "" };

    try {
      await act(async () =>
        root.render(<BotAvatar bot={bot} live={reduced} state="idle" />),
      );
      expect(paint.mock.calls.at(-1)?.[2]).toEqual([["calm", 1]]);
      await act(async () =>
        root.render(<BotAvatar bot={bot} live={reduced} state="working" />),
      );
      expect(paint.mock.calls.at(-1)?.[2]).toEqual([["focused", 1]]);
    } finally {
      await act(async () => root.unmount());
      paint.mockRestore();
      getContext.mockRestore();

      for (const key of [
        "window",
        "document",
        "devicePixelRatio",
        "Path2D",
        "matchMedia",
        "IS_REACT_ACT_ENVIRONMENT",
      ]) {
        if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
        else Reflect.deleteProperty(globalThis, key);
      }

      window.close();
    }
  });
}
