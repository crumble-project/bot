/**
 * States an invariant TypeScript cannot see, such as a row a repository just wrote.
 *
 * `required` throws with `message` instead of the `TypeError` a missing value would raise later, so a broken
 * invariant names itself.
 */
export function required<A>(value: A | null | undefined, message: string): A {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}
