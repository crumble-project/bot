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

/** The server name of a complete TLS ClientHello, or null. */
export function readSni(data: Buffer): string | null {
  try {
    if (data[0] !== 22 || data[1] !== 3 || data[5] !== 1) return null;
    const end = 5 + data.readUInt16BE(3);

    if (end > data.length || data.readUIntBE(6, 3) + 9 !== end) return null;
    let at = 43;
    at += 1 + data.readUInt8(at);
    const ciphers = data.readUInt16BE(at);

    if (!ciphers || ciphers % 2) return null;
    at += 2 + ciphers;
    at += 1 + data.readUInt8(at);
    const extensionsEnd = at + 2 + data.readUInt16BE(at);

    if (extensionsEnd !== end) return null;
    at += 2;
    let host: string | null = null;

    while (at < end) {
      const type = data.readUInt16BE(at);
      const length = data.readUInt16BE(at + 2);
      at += 4;
      const next = at + length;

      if (next > end) return null;

      if (type === 0) {
        if (
          host ||
          length < 5 ||
          data.readUInt16BE(at) !== length - 2 ||
          data[at + 2] !== 0 ||
          data.readUInt16BE(at + 3) !== length - 5
        )
          return null;
        host = hostname(data.toString("latin1", at + 5, next));

        if (!host) return null;
      }

      at = next;
    }

    return host;
  } catch {
    return null;
  }
}

/** The host of a complete HTTP/1 request header, without its port. */
export function readHttpHost(data: Buffer): string | null {
  const end = data.indexOf("\r\n\r\n");

  if (end < 0) return null;
  const [request, ...headers] = data.toString("latin1", 0, end).split("\r\n");

  if (!request || !/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(request)) return null;
  let host: string | null = null;

  for (const header of headers) {
    const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(header);

    if (!match) return null;

    if (match[1]?.toLowerCase() !== "host") continue;

    if (host) return null;
    const authority = /^([^:]+)(?::([0-9]+))?$/.exec(match[2]?.trim() ?? "");

    if (!authority || (authority[2] && !validPort(Number(authority[2]))))
      return null;
    host = hostname(authority[1] ?? "");

    if (!host) return null;
  }

  return host;
}

export const validPort = (port: number) =>
  Number.isInteger(port) && port > 0 && port <= 65535;
