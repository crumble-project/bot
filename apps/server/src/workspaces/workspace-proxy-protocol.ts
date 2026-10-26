function hostname(value: string): string | null {
  const host = value.toLowerCase().replace(/\.$/, "");

  if (
    host.length > 253 ||
    !host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;

  return host;
}

function validHelloEnvelope(data: Buffer): number | null {
  if (data[0] !== 22 || data[1] !== 3 || data[5] !== 1) return null;
  const end = 5 + data.readUInt16BE(3);

  if (end > data.length || data.readUIntBE(6, 3) + 9 !== end) return null;

  return end;
}

/** Offset of the extensions block, or null when the cipher list is invalid. */
function extensionsStart(data: Buffer): number | null {
  let at = 43;
  at += 1 + data.readUInt8(at);
  const ciphers = data.readUInt16BE(at);

  if (!ciphers || ciphers % 2) return null;
  at += 2 + ciphers;
  at += 1 + data.readUInt8(at);

  return at;
}

function validServerNameList(data: Buffer, at: number, length: number) {
  return (
    length >= 5 &&
    data.readUInt16BE(at) === length - 2 &&
    data[at + 2] === 0 &&
    data.readUInt16BE(at + 3) === length - 5
  );
}

function readServerName(
  data: Buffer,
  at: number,
  length: number,
  found: string | null,
): string | null {
  if (found || !validServerNameList(data, at, length)) return null;

  return hostname(data.toString("latin1", at + 5, at + length));
}

function readExtensions(data: Buffer, from: number, end: number) {
  let at = from;
  let host: string | null = null;

  while (at < end) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    at += 4;

    if (at + length > end) return null;

    if (type === 0) {
      host = readServerName(data, at, length, host);

      if (!host) return null;
    }

    at += length;
  }

  return host;
}

/** The server name of a complete TLS ClientHello, or null. */
export function readSni(data: Buffer): string | null {
  try {
    const end = validHelloEnvelope(data);
    const at = end === null ? null : extensionsStart(data);

    if (end === null || at === null) return null;

    if (at + 2 + data.readUInt16BE(at) !== end) return null;

    return readExtensions(data, at + 2, end);
  } catch {
    return null;
  }
}

function readHostHeader(value: string): string | null {
  const authority = /^([^:]+)(?::([0-9]+))?$/.exec(value.trim());

  if (!authority || (authority[2] && !validPort(Number(authority[2]))))
    return null;

  return hostname(authority[1] ?? "");
}

const HEADER_LINE = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/;

/** The one Host header's host, null when a header is malformed or Host repeats or is invalid. */
function hostOfHeaders(headers: string[]): string | null {
  let host: string | null = null;

  for (const header of headers) {
    const match = HEADER_LINE.exec(header);

    if (!match) return null;

    if (match[1]?.toLowerCase() !== "host") continue;

    if (host) return null;
    host = readHostHeader(match[2] ?? "");

    if (!host) return null;
  }

  return host;
}

/** The host of a complete HTTP/1 request header, without its port. */
export function readHttpHost(data: Buffer): string | null {
  const end = data.indexOf("\r\n\r\n");

  if (end < 0) return null;
  const [request, ...headers] = data.toString("latin1", 0, end).split("\r\n");

  if (!request || !/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(request)) return null;

  return hostOfHeaders(headers);
}

export const validPort = (port: number) =>
  Number.isInteger(port) && port > 0 && port <= 65535;
