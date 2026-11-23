export function required<A>(value: A | null | undefined, message: string): A {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}
