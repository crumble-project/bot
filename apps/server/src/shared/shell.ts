/** One word for a POSIX shell, whatever `value` holds. */
export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", `'\\''`)}'`;
