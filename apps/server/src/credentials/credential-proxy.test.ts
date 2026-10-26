import { describe, expect, test } from "bun:test";
import { requestHeaders, responseHeaders } from "./credential-proxy";

const placeholder = "$ACME_TOKEN";
const value = "s3cret-value";

const swap = (text: string) => text.replaceAll(placeholder, value);
const scrub = (text: string) => text.replaceAll(value, placeholder);

const basic = (credentials: string) =>
  `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;

describe("credential proxy request headers", () => {
  test("swaps placeholders in values and drops hop-by-hop headers", () => {
    expect(
      requestHeaders(
        [
          "Connection",
          "keep-alive",
          "Accept-Encoding",
          "gzip",
          "X-Acme-Token",
          placeholder,
          "Accept",
          "*/*",
        ],
        swap,
      ),
    ).toEqual({ "x-acme-token": [value], accept: ["*/*"] });
  });

  test("lowercases names and keeps repeated headers in order", () => {
    expect(requestHeaders(["X-Tag", "one", "X-Tag", "two"], swap)).toEqual({
      "x-tag": ["one", "two"],
    });
  });

  test("swaps the credentials inside a Basic authorization, and re-encodes them", () => {
    expect(
      requestHeaders(["Authorization", basic(`bot:${placeholder}`)], swap),
    ).toEqual({ authorization: [basic(`bot:${value}`)] });
  });

  test("swaps other authorization headers as they are", () => {
    expect(
      requestHeaders(["Authorization", `Bearer ${placeholder}`], swap),
    ).toEqual({ authorization: [`Bearer ${value}`] });

    // A Basic header holding more than one token is not a credential to decode, so it is swapped as text.
    expect(
      requestHeaders(["Authorization", `Basic ${placeholder} extra`], swap),
    ).toEqual({ authorization: [`Basic ${value} extra`] });
  });
});

describe("credential proxy response headers", () => {
  test("scrubs values and lowercases names", () => {
    expect(
      responseHeaders(
        ["Content-Type", "text/plain", "X-Echo", value],
        false,
        scrub,
      ),
    ).toEqual({ "content-type": ["text/plain"], "x-echo": [placeholder] });
  });

  test("drops content-length only when the body is scrubbed", () => {
    expect(responseHeaders(["Content-Length", "9"], false, scrub)).toEqual({
      "content-length": ["9"],
    });
    expect(responseHeaders(["Content-Length", "9"], true, scrub)).toEqual({});
  });

  test("drops hop-by-hop headers and keeps repeated ones in order", () => {
    expect(
      responseHeaders(
        [
          "Transfer-Encoding",
          "chunked",
          "Set-Cookie",
          "a=1",
          "Set-Cookie",
          "b=2",
        ],
        false,
        scrub,
      ),
    ).toEqual({ "set-cookie": ["a=1", "b=2"] });
  });
});
