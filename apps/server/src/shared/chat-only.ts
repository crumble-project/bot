import type { Extension } from "@earendil-works/pi-durable";

const chatOnlyExtensions = new WeakSet<Extension>();

/** Keeps `extension` out of group turns, so whatever it offers stays in the bot's own chat. */
export const chatOnly = <E extends Extension>(extension: E) => {
  chatOnlyExtensions.add(extension);

  return extension;
};

/** Whether a group turn offers `extension`. */
export const inGroupTurns = (extension: Extension) =>
  !chatOnlyExtensions.has(extension);
