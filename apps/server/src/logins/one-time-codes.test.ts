import { expect, test } from "bun:test";
import { oneTimeCode, parseOneTimeSecret } from "./one-time-codes";

// RFC 6238 appendix B, SHA-1: the ASCII key "12345678901234567890" in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("codes match the RFC 6238 SHA-1 vectors", () => {
  const secret = parseOneTimeSecret(
    `otpauth://totp/Test?secret=${RFC_SECRET}&digits=8`,
  )!;

  expect(oneTimeCode(secret, 59_000)).toBe("94287082");
  expect(oneTimeCode(secret, 1_111_111_109_000)).toBe("07081804");
  expect(oneTimeCode(secret, 1_234_567_890_000)).toBe("89005924");
  expect(oneTimeCode(secret, 20_000_000_000_000)).toBe("65353130");
});

test("a bare base32 secret gives six digits every thirty seconds", () => {
  const secret = parseOneTimeSecret("jbsw y3dp ehpk 3pxp")!;

  expect(secret).toMatchObject({ digits: 6, periodSeconds: 30 });
  expect(oneTimeCode(secret, 0)).toBe("282760");
  expect(oneTimeCode(secret, 29_999)).toBe("282760");
  expect(oneTimeCode(secret, 30_000)).toBe("996554");
});

test("a URI's algorithm and period are honored", () => {
  const sha256 = parseOneTimeSecret(
    "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&digits=8&algorithm=SHA256&period=60",
  )!;

  expect(sha256).toMatchObject({ algorithm: "sha256", periodSeconds: 60 });
  expect(oneTimeCode(sha256, 59_999)).toBe("18920136");
  // RFC 6238's SHA-256 vector for step 1 (59 s at 30 s), reached at 60 s here.
  expect(oneTimeCode(sha256, 60_000)).toBe("46119246");
});

test("secrets that aren't base32 or a TOTP URI are rejected", () => {
  expect(parseOneTimeSecret("not a secret!")).toBeUndefined();
  expect(parseOneTimeSecret("")).toBeUndefined();
  expect(
    parseOneTimeSecret(`otpauth://hotp/Test?secret=${RFC_SECRET}`),
  ).toBeUndefined();
  expect(
    parseOneTimeSecret(`otpauth://totp/Test?secret=${RFC_SECRET}&digits=4`),
  ).toBeUndefined();
});

test("periods that aren't a positive whole number of seconds are rejected", () => {
  for (const period of ["0", "0.5", "Infinity", "-30", "1e400"])
    expect(
      parseOneTimeSecret(
        `otpauth://totp/Test?secret=${RFC_SECRET}&period=${period}`,
      ),
    ).toBeUndefined();
});
