export function requestPath(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }

  return "url" in input ? input.url : input.toString();
}
