/**
 * The path a fetch mock was called with. Callers pass a path string, but the
 * `fetch` signature also allows a `URL` or a `Request`.
 */
export function requestPath(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }

  return "url" in input ? input.url : input.toString();
}
