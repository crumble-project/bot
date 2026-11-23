export const guestTrustEnv = (bundle: string, certificate: string) => ({
  SSL_CERT_FILE: bundle,

  GIT_SSL_CAINFO: bundle,
  REQUESTS_CA_BUNDLE: bundle,
  CURL_CA_BUNDLE: bundle,
  NODE_EXTRA_CA_CERTS: certificate,

  NODE_USE_ENV_PROXY: "1",
});
