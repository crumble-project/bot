import { expect } from "bun:test";

export function defined<T>(value: T | null | undefined, what: string): T {
  expect(value).toBeDefined();

  if (value === null || value === undefined) {
    throw new Error(`${what} was not registered`);
  }

  return value;
}
