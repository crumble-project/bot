import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

// OpenSSH's signature format: PROTOCOL.sshsig in the OpenSSH sources.
const MAGIC = Buffer.from("SSHSIG");
const KEY_TYPE = "ssh-ed25519";
const HASH = "sha512";

const sshBytes = (bytes: Uint8Array) => {
  const length = Buffer.alloc(4);

  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
};

const sshString = (text: string) => sshBytes(Buffer.from(text));

/** The key's 32 raw public bytes, from its SPKI DER encoding. */
const rawPublicKey = (key: KeyObject) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);

const publicKeyBlob = (key: KeyObject) =>
  Buffer.concat([sshString(KEY_TYPE), sshBytes(rawPublicKey(key))]);

/** A new Ed25519 private key in PKCS #8 PEM, to store as a secret. */
export const newSigningKey = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();

/** The key's public half as an OpenSSH line, which the owner adds to GitHub as a signing key. */
export const sshPublicKey = (privateKeyPem: string, comment: string) =>
  `${KEY_TYPE} ${publicKeyBlob(createPrivateKey(privateKeyPem)).toString("base64")} ${comment}`;

/** An armored SSH signature of `data`, as `ssh-keygen -Y sign -n <namespace>` writes it. */
export function sshSign(
  privateKeyPem: string,
  data: Uint8Array,
  namespace: string,
) {
  const key = createPrivateKey(privateKeyPem);
  const digest = createHash(HASH).update(data).digest();

  const signed = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshBytes(digest),
  ]);

  const signature = Buffer.concat([
    sshString(KEY_TYPE),
    sshBytes(sign(null, signed, key)),
  ]);

  const version = Buffer.alloc(4);

  version.writeUInt32BE(1);

  const blob = Buffer.concat([
    MAGIC,
    version,
    sshBytes(publicKeyBlob(key)),
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshBytes(signature),
  ]).toString("base64");

  return `-----BEGIN SSH SIGNATURE-----\n${blob.match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}
