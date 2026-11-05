/** The variables that make a job's tools trust the credential proxy and route through it, given the guest's CA paths. */
export const guestTrustEnv = (bundle: string, certificate: string) => ({
  SSL_CERT_FILE: bundle,
  // Debian's git uses GnuTLS, which ignores SSL_CERT_FILE.
  GIT_SSL_CAINFO: bundle,
  REQUESTS_CA_BUNDLE: bundle,
  CURL_CA_BUNDLE: bundle,
  NODE_EXTRA_CA_CERTS: certificate,
  // Node's own fetch ignores the proxy variables without it.
  NODE_USE_ENV_PROXY: "1",
});
