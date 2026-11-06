import type { Extension } from "@earendil-works/pi-durable";

const chatOnlyExtensions = new WeakSet<Extension>();

export const chatOnly = <E extends Extension>(extension: E) => {
  chatOnlyExtensions.add(extension);

  return extension;
};

export const inGroupTurns = (extension: Extension) =>
  !chatOnlyExtensions.has(extension);
