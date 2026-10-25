import { randomBytes } from "node:crypto";
import tls from "node:tls";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { Context, Effect, Layer, type ManagedRuntime } from "effect";
import { AgentCredentialRepository } from "./agent-credential-repository";

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTHORITY_DAYS = 3650;
const HOST_DAYS = 7;

// A host certificate this close to expiry is replaced before it is served.
const RENEW_MS = DAY_MS;

const COMMON_NAME = "2.5.4.3";
const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";
const SUBJECT_KEY_ID = "2.5.29.14";
const AUTHORITY_KEY_ID = "2.5.29.35";
const SUBJECT_ALT_NAME = "2.5.29.17";
const EXTENDED_KEY_USAGE = "2.5.29.37";
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

// Key usage bits, first byte of the BIT STRING: digitalSignature 0x80, keyCertSign 0x04, cRLSign 0x02.
const CA_KEY_USAGE = 0x06;
const SERVER_KEY_USAGE = 0x80;

pkijs.setEngine("crumble", new pkijs.CryptoEngine({ name: "crumble", crypto }));

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/.{64}/g, "$&\n")
    .trimEnd()}\n-----END ${label}-----\n`;

const der = (text: string) =>
  Uint8Array.from(
    Buffer.from(
      text.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""),
      "base64",
    ),
  ).buffer;

const commonName = (value: string) =>
  new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: COMMON_NAME,
        value: new asn1js.Utf8String({ value }),
      }),
    ],
  });

const extension = (
  extnID: string,
  critical: boolean,
  value: asn1js.BaseBlock,
) => new pkijs.Extension({ extnID, critical, extnValue: value.toBER(false) });

const keyUsage = (bits: number) =>
  new asn1js.BitString({ valueHex: Uint8Array.of(bits).buffer });

/** SHA-1 of the subject public key, as RFC 5280 suggests for key identifiers. */
async function keyIdentifier(certificate: pkijs.Certificate) {
  return crypto.subtle.digest(
    "SHA-1",
    certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView.slice(),
  );
}

async function signed(
  options: {
    subject: string;
    issuer: string;
    days: number;
    publicKey: CryptoKey;
    signingKey: CryptoKey;
  },
  extensions: (certificate: pkijs.Certificate) => Promise<pkijs.Extension[]>,
) {
  const certificate = new pkijs.Certificate();
  const serial = randomBytes(16);

  // A positive serial: DER integers are signed.
  serial[0]! &= 0x7f;
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ valueHex: serial });
  certificate.subject = commonName(options.subject);
  certificate.issuer = commonName(options.issuer);
  certificate.notBefore.value = new Date(Date.now() - DAY_MS);
  certificate.notAfter.value = new Date(Date.now() + options.days * DAY_MS);
  await certificate.subjectPublicKeyInfo.importKey(options.publicKey);
  certificate.extensions = await extensions(certificate);
  await certificate.sign(options.signingKey, "SHA-256");

  return certificate;
}

const AUTHORITY_NAME = "Crumble credential proxy";

type Authority = {
  certificate: pkijs.Certificate;
  certificatePem: string;
  key: CryptoKey;
  keyId: ArrayBuffer;
};

type HostContext = { context: tls.SecureContext; expires: number };

/**
 * One certificate authority per bot, which its workspace trusts, and the certificates the credential proxy presents
 * for the bot's credential hosts. The authority's key stays on the server, encrypted in the database.
 */
export class CredentialAuthorities extends Context.Service<
  CredentialAuthorities,
  {
    /** The bot's authority certificate in PEM, created on first use. */
    readonly certificate: (agentId: string) => Effect.Effect<string>;
    /** The TLS context the credential proxy presents for `host` to the bot's workspace. */
    readonly context: (
      agentId: string,
      host: string,
    ) => Effect.Effect<tls.SecureContext>;
  }
>()("crumble/credentials/CredentialAuthorities") {
  static readonly layer = Layer.effect(
    CredentialAuthorities,
    Effect.gen(function* () {
      const repository = yield* AgentCredentialRepository;

      const run = Effect.runPromiseWith(
        yield* Effect.context<AgentCredentialRepository>(),
      );

      const authorities = new Map<string, Promise<Authority>>();
      const hosts = new Map<string, Promise<HostContext>>();

      // One key for every host certificate of this process; certificates are cheap, keys need not be.
      const hostKeys = crypto.subtle.generateKey(KEY_ALGORITHM, true, [
        "sign",
        "verify",
      ]);

      const loadAuthority = async (agentId: string): Promise<Authority> => {
        const saved =
          (await run(repository.getAuthority(agentId))) ??
          (await run(repository.saveAuthority(agentId, await newAuthority())));

        const certificate = pkijs.Certificate.fromBER(der(saved.certificate));

        return {
          certificate,
          certificatePem: saved.certificate,
          key: await crypto.subtle.importKey(
            "pkcs8",
            der(saved.key),
            KEY_ALGORITHM,
            false,
            ["sign"],
          ),
          keyId: await keyIdentifier(certificate),
        };
      };

      const authority = (agentId: string) => {
        let loading = authorities.get(agentId);

        if (!loading) {
          loading = loadAuthority(agentId);
          authorities.set(agentId, loading);
          loading.catch(() => authorities.delete(agentId));
        }

        return loading;
      };

      const hostContext = async (
        agentId: string,
        host: string,
      ): Promise<HostContext> => {
        const issuer = await authority(agentId);
        const keys = await hostKeys;

        const certificate = await signed(
          {
            subject: host,
            issuer: AUTHORITY_NAME,
            days: HOST_DAYS,
            publicKey: keys.publicKey,
            signingKey: issuer.key,
          },
          async () => [
            extension(
              BASIC_CONSTRAINTS,
              true,
              new pkijs.BasicConstraints({ cA: false }).toSchema(),
            ),
            extension(KEY_USAGE, true, keyUsage(SERVER_KEY_USAGE)),
            extension(
              EXTENDED_KEY_USAGE,
              false,
              new pkijs.ExtKeyUsage({ keyPurposes: [SERVER_AUTH] }).toSchema(),
            ),
            extension(
              SUBJECT_ALT_NAME,
              false,
              new pkijs.AltName({
                altNames: [new pkijs.GeneralName({ type: 2, value: host })],
              }).toSchema(),
            ),
            // Strict verifiers, such as Python 3.13 and later, require it.
            extension(
              AUTHORITY_KEY_ID,
              false,
              new pkijs.AuthorityKeyIdentifier({
                keyIdentifier: new asn1js.OctetString({
                  valueHex: issuer.keyId,
                }),
              }).toSchema(),
            ),
          ],
        );

        return {
          context: tls.createSecureContext({
            cert: pem("CERTIFICATE", certificate.toSchema(true).toBER(false)),
            key: pem(
              "PRIVATE KEY",
              await crypto.subtle.exportKey("pkcs8", keys.privateKey),
            ),
          }),
          expires: certificate.notAfter.value.getTime(),
        };
      };

      const context = async (agentId: string, host: string) => {
        const key = `${agentId}\n${host}`;
        const cached = await hosts.get(key)?.catch(() => undefined);

        if (cached && cached.expires - Date.now() > RENEW_MS)
          return cached.context;

        const created = hostContext(agentId, host);

        hosts.set(key, created);
        created.catch(() => hosts.delete(key));

        return (await created).context;
      };

      return CredentialAuthorities.of({
        certificate: Effect.fn("CredentialAuthorities.certificate")(
          (agentId: string) =>
            Effect.promise(
              async () => (await authority(agentId)).certificatePem,
            ),
        ),
        context: Effect.fn("CredentialAuthorities.context")(
          (agentId: string, host: string) =>
            Effect.promise(() => context(agentId, host)),
        ),
      });
    }),
  );
}

async function newAuthority() {
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ]);

  const certificate = await signed(
    {
      subject: AUTHORITY_NAME,
      issuer: AUTHORITY_NAME,
      days: AUTHORITY_DAYS,
      publicKey: keys.publicKey,
      signingKey: keys.privateKey,
    },
    async (self) => [
      // pathLenConstraint 0: it signs host certificates, never another authority.
      extension(
        BASIC_CONSTRAINTS,
        true,
        new pkijs.BasicConstraints({
          cA: true,
          pathLenConstraint: 0,
        }).toSchema(),
      ),
      extension(KEY_USAGE, true, keyUsage(CA_KEY_USAGE)),
      extension(
        SUBJECT_KEY_ID,
        false,
        new asn1js.OctetString({ valueHex: await keyIdentifier(self) }),
      ),
    ],
  );

  return {
    certificate: pem("CERTIFICATE", certificate.toSchema(true).toBER(false)),
    key: pem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
  };
}

/** Certificate authorities for code outside Effect: workspace boots and the credential proxy. */
export type CredentialAuthoritiesAccess = {
  certificate(agentId: string): Promise<string>;
  context(agentId: string, host: string): Promise<tls.SecureContext>;
};

export function credentialAuthoritiesAccess(
  runtime: ManagedRuntime.ManagedRuntime<CredentialAuthorities, unknown>,
): CredentialAuthoritiesAccess {
  const authorities = runtime.runSync(
    CredentialAuthorities.use(Effect.succeed),
  );

  return {
    certificate: (agentId) =>
      runtime.runPromise(authorities.certificate(agentId)),
    context: (agentId, host) =>
      runtime.runPromise(authorities.context(agentId, host)),
  };
}
