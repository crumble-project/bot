import net from "node:net";

const PRIVATE = new net.BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");

const GLOBAL_V6 = new net.BlockList();

GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

/** Only globally routable addresses; transition and mapped IPv6 addresses are refused. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return !PRIVATE.check(address, "ipv4");

  return (
    net.isIPv6(address) &&
    !address.includes("%") &&
    GLOBAL_V6.check(address, "ipv6") &&
    !PRIVATE.check(address, "ipv6")
  );
}
