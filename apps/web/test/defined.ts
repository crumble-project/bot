import { expect } from "bun:test";

/**
 * A value a test steps through, failing the test when it is absent. The step it
 * guards must not quietly vanish because the component never registered it.
 */
export function defined<T>(value: T | null | undefined, what: string): T {
  expect(value).toBeDefined();

  if (value === null || value === undefined) {
    throw new Error(`${what} was not registered`);
  }

  return value;
}
