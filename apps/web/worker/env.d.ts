// The two Worker secrets: `wrangler types` sees only vars, so they are declared here.
interface WorkerSecrets {
  OWNER_EMAIL: string;
  /** Comma-separated SHA-256 fingerprints, at most two (one while rotating). */
  LINK_CERT_FINGERPRINTS: string;
}
interface Env extends WorkerSecrets {}
declare namespace Cloudflare {
  interface Env extends WorkerSecrets {}
}
