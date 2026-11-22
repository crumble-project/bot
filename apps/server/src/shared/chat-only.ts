import type { Extension } from "@earendil-works/pi-durable";

const callOnlyExtensions = new WeakSet<Extension>();

/** Offered only to the conversation of an outside call: the bot chat leaves it out. */
export const callOnly = <E extends Extension>(extension: E) => {
  callOnlyExtensions.add(extension);

  return extension;
};

export const isCallOnly = (extension: Extension) =>
  callOnlyExtensions.has(extension);

export const inChat = (extension: Extension) => !isCallOnly(extension);
