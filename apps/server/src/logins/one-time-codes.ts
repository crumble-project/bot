import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const ALGORITHMS = new Map([
  ["SHA1", "sha1"],
  ["SHA256", "sha256"],
  ["SHA512", "sha512"],
]);

/** A TOTP secret with its parameters (RFC 6238); the defaults are what authenticator apps assume. */
export type OneTimeSecret = {
  key: Buffer;
  digits: number;
  periodSeconds: number;
  algorithm: string;
};

/** RFC 4648 base32 without padding; undefined for any other character. */
function base32(text: string) {
  const bits: number[] = [];

  for (const char of text.replace(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);

    if (index < 0) return undefined;

    for (let bit = 4; bit >= 0; bit--) bits.push((index >> bit) & 1);
  }

  const bytes = [];

  for (let at = 0; at + 8 <= bits.length; at += 8)
    bytes.push(bits.slice(at, at + 8).reduce((byte, bit) => byte * 2 + bit, 0));

  return bytes.length ? Buffer.from(bytes) : undefined;
}

const DEFAULTS = { digits: 6, periodSeconds: 30, algorithm: "sha1" };

/** A URI's parameters, each defaulted; undefined when one is outside what authenticator apps accept. */
function parametersOf(params: URLSearchParams) {
  const digits = Number(params.get("digits") ?? DEFAULTS.digits);

  const periodSeconds = Number(params.get("period") ?? DEFAULTS.periodSeconds);

  const algorithm = ALGORITHMS.get(
    (params.get("algorithm") ?? "SHA1").toUpperCase(),
  );

  const valid =
    algorithm &&
    [6, 7, 8].includes(digits) &&
    Number.isSafeInteger(periodSeconds) &&
    periodSeconds > 0;

  return valid ? { digits, periodSeconds, algorithm } : undefined;
}

function fromUri(uri: URL): OneTimeSecret | undefined {
  if (uri.protocol !== "otpauth:" || uri.hostname !== "totp") return undefined;

  const key = base32(uri.searchParams.get("secret") ?? "");
  const parameters = parametersOf(uri.searchParams);

  return key && parameters && { key, ...parameters };
}

/** A base32 secret or an `otpauth://totp/` URI, as an authenticator app's QR code holds it; undefined when neither. */
export function parseOneTimeSecret(text: string): OneTimeSecret | undefined {
  const trimmed = text.trim();

  if (URL.canParse(trimmed) && trimmed.startsWith("otpauth:"))
    return fromUri(new URL(trimmed));

  const key = base32(trimmed);

  return key && { key, ...DEFAULTS };
}

/** The code for the time step containing `atMs`. */
export function oneTimeCode(secret: OneTimeSecret, atMs: number) {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(
    BigInt(Math.floor(atMs / 1000 / secret.periodSeconds)),
  );

  const mac = createHmac(secret.algorithm, secret.key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;

  return String(binary % 10 ** secret.digits).padStart(secret.digits, "0");
}
