import type { Extension } from "@earendil-works/pi-durable";

const chatOnlyExtensions = new WeakSet<Extension>();

const callOnlyExtensions = new WeakSet<Extension>();

export const chatOnly = <E extends Extension>(extension: E) => {
  chatOnlyExtensions.add(extension);

  return extension;
};

/** Offered only to the conversation of an outside call: the chat and group turns leave it out. */
export const callOnly = <E extends Extension>(extension: E) => {
  callOnlyExtensions.add(extension);

  return extension;
};

export const isCallOnly = (extension: Extension) =>
  callOnlyExtensions.has(extension);

export const inChat = (extension: Extension) => !isCallOnly(extension);

export const inGroupTurns = (extension: Extension) =>
  !chatOnlyExtensions.has(extension) && inChat(extension);
