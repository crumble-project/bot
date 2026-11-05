import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { Composer } from "./composer";

async function withComposer(
  onSend: () => Promise<boolean>,
  run: (
    container: HTMLElement,
    window: Window,
    remount: () => Promise<void>,
  ) => Promise<void>,
) {
  const window = new Window();
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    // The + menu's positioning checks for elements with the global constructor.
    Element: { configurable: true, value: window.Element },
    Event: { configurable: true, value: window.Event },
    localStorage: { configurable: true, value: window.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  let root = createRoot(container);

  const mount = () =>
    act(async () =>
      root.render(
        <Composer
          draftKey="bot:test"
          placeholder="Message"
          running={false}
          onSend={onSend}
          onStop={() => {}}
        />,
      ),
    );

  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
  };

  try {
    await mount();
    await run(container, window, remount);
  } finally {
    await act(async () => root.unmount());

    for (const key of [
      "window",
      "document",
      "HTMLElement",
      "Element",
      "Event",
      "localStorage",
      "IS_REACT_ACT_ENVIRONMENT",
    ]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
}

function event(type: string) {
  return new Event(type, { bubbles: true, cancelable: true });
}

function typeMessage(container: HTMLElement, window: Window, value: string) {
  const field = container.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set?.call(field, value);
  field.dispatchEvent(event("input"));
}

function attach(container: HTMLElement, names: string[]) {
  const picker = container.querySelector('input[type="file"]')!;
  Object.defineProperty(picker, "files", {
    configurable: true,
    value: names.map((name) => new File([name], name, { type: "text/plain" })),
  });
  picker.dispatchEvent(event("change"));
}

test("failed send preserves pending and new text and attachments, and blocks over-limit retry", async () => {
  let finish!: (value: boolean) => void;
  let calls = 0;

  const pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });

  await withComposer(
    () => {
      calls++;

      return pending;
    },
    async (container, window) => {
      await act(async () => typeMessage(container, window, "first"));
      await act(async () =>
        attach(
          container,
          Array.from({ length: 8 }, (_, i) => `old${i}.txt`),
        ),
      );
      await act(async () =>
        container.querySelector("form")!.dispatchEvent(event("submit")),
      );
      await act(async () => typeMessage(container, window, "second"));
      await act(async () => attach(container, ["new.txt"]));
      await act(async () => finish(false));
      expect(container.querySelector("textarea")!.value).toBe("first\nsecond");

      for (let i = 0; i < 8; i++)
        expect(container.textContent).toContain(`old${i}.txt`);
      expect(container.textContent).toContain("new.txt");
      expect(container.textContent).toContain("Attach at most 8 files.");
      expect(
        container.querySelector<HTMLButtonElement>('[title="Send"]')!.disabled,
      ).toBe(true);
      await act(async () =>
        container.querySelector("form")!.dispatchEvent(event("submit")),
      );
      expect(calls).toBe(1);
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[title="Remove new.txt"]')!
          .click(),
      );
      expect(container.textContent).not.toContain("Remove 1 to send");
      expect(
        container.querySelector<HTMLButtonElement>('[title="Send"]')!.disabled,
      ).toBe(false);
    },
  );
});

test("attachment processing finishing after recovery preserves the new file", async () => {
  let finishSend!: (value: boolean) => void;
  let finishFile!: (value: ArrayBuffer) => void;

  const pending = new Promise<boolean>((resolve) => {
    finishSend = resolve;
  });

  await withComposer(
    () => pending,
    async (container) => {
      await act(async () =>
        attach(
          container,
          Array.from({ length: 8 }, (_, i) => `old${i}.txt`),
        ),
      );
      await act(async () =>
        container.querySelector("form")!.dispatchEvent(event("submit")),
      );
      const file = new File(["new"], "new.txt", { type: "text/plain" });
      file.arrayBuffer = () =>
        new Promise((resolve) => {
          finishFile = resolve;
        });
      const picker = container.querySelector('input[type="file"]')!;
      await act(async () => {
        Object.defineProperty(picker, "files", {
          configurable: true,
          value: [file],
        });
        picker.dispatchEvent(event("change"));
      });
      await act(async () => finishSend(false));
      await act(async () => finishFile(new TextEncoder().encode("new").buffer));
      expect(container.textContent).toContain("old0.txt");
      expect(container.textContent).toContain("new.txt");
      expect(container.textContent).toContain("Remove 1 to send");
      expect(
        container.querySelector<HTMLButtonElement>('[title="Send"]')!.disabled,
      ).toBe(true);
    },
  );
});

test("rejected send restores the draft and enables Send", async () => {
  await withComposer(
    async () => {
      throw new Error("send failed");
    },
    async (container, window) => {
      await act(async () => typeMessage(container, window, "message"));
      await act(async () =>
        container.querySelector("form")!.dispatchEvent(event("submit")),
      );
      expect(container.querySelector("textarea")!.value).toBe("message");
      expect(
        container.querySelector<HTMLButtonElement>('[title="Send"]')!.disabled,
      ).toBe(false);
    },
  );
});

test("concurrent attachment additions retain both files", async () => {
  await withComposer(
    async () => true,
    async (container) => {
      const picker = container.querySelector('input[type="file"]')!;
      const first = new File(["one"], "one.txt", { type: "text/plain" });
      const second = new File(["two"], "two.txt", { type: "text/plain" });
      let finish!: (value: ArrayBuffer) => void;
      first.arrayBuffer = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await act(async () => {
        Object.defineProperty(picker, "files", {
          configurable: true,
          value: [first],
        });
        picker.dispatchEvent(event("change"));
        Object.defineProperty(picker, "files", {
          configurable: true,
          value: [second],
        });
        picker.dispatchEvent(event("change"));
      });
      await act(async () => finish(new TextEncoder().encode("one").buffer));
      expect(container.textContent).toContain("one.txt");
      expect(container.textContent).toContain("two.txt");
    },
  );
});

test("a draft survives leaving the chat and is cleared once sent", async () => {
  await withComposer(
    async () => true,
    async (container, window, remount) => {
      await act(async () => typeMessage(container, window, "half a thought"));
      await remount();

      expect(container.querySelector("textarea")!.value).toBe("half a thought");

      await act(async () =>
        container.querySelector("form")!.dispatchEvent(event("submit")),
      );
      await remount();

      expect(container.querySelector("textarea")!.value).toBe("");
    },
  );
});

test("typing keeps working when the draft can't be saved", async () => {
  await withComposer(
    async () => true,
    async (container, window) => {
      const storage = window.Storage.prototype;
      const setItem = Object.getOwnPropertyDescriptor(storage, "setItem")!;

      Object.defineProperty(storage, "setItem", {
        configurable: true,
        value: () => {
          throw new window.DOMException(
            "Storage is full",
            "QuotaExceededError",
          );
        },
      });

      try {
        await act(async () => typeMessage(container, window, "still here"));
      } finally {
        Object.defineProperty(storage, "setItem", setItem);
      }

      expect(container.querySelector("textarea")!.value).toBe("still here");
    },
  );
});

test("attachments work where crypto.randomUUID is missing, as on plain http", async () => {
  const randomUUID = spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new TypeError("crypto.randomUUID is not a function");
  });

  try {
    await withComposer(
      async () => true,
      async (container) => {
        await act(async () => attach(container, ["notes.txt"]));
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
        expect(container.textContent).toContain("notes.txt");
      },
    );
  } finally {
    randomUUID.mockRestore();
  }
});
