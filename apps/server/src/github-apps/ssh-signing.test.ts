import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { newSigningKey, sshPublicKey, sshSign } from "./ssh-signing";

const sshKeygen = Bun.which("ssh-keygen");

// The format is OpenSSH's; its own tool is the judge where it's installed.
test.skipIf(!sshKeygen)("ssh-keygen accepts the signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "sshsig-"));

  try {
    const key = newSigningKey();
    const data = Buffer.from("tree 1234\nauthor bot\n\ncommit message\n");
    const signers = join(dir, "allowed_signers");

    writeFileSync(
      signers,
      `bot@example.test ${sshPublicKey(key, "bot").split(" ").slice(0, 2).join(" ")}\n`,
    );
    writeFileSync(join(dir, "data.sig"), sshSign(key, data, "git"));

    const verify = (namespace: string, signed: Uint8Array) =>
      Bun.spawnSync(
        [
          sshKeygen!,
          "-Y",
          "verify",
          "-f",
          signers,
          "-I",
          "bot@example.test",
          "-n",
          namespace,
          "-s",
          join(dir, "data.sig"),
        ],
        { stdin: signed },
      ).exitCode;

    expect(verify("git", data)).toBe(0);
    expect(verify("file", data)).not.toBe(0);
    expect(verify("git", Buffer.from("tampered"))).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
