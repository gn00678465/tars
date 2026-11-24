import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

interface AccessConfig {
  readonly teamDomain: string;
  readonly aud: string;
  readonly ownerEmail: string;
}

/** The JWT the request carries: Access's header first, then its cookie. */
export function accessJwt(request: Request): string | undefined {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header !== null && header !== "") return header;
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === "CF_Authorization") {
      const value = part.slice(eq + 1).trim();
      if (value !== "") return value;
    }
  }
  return undefined;
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** Access's public keys for a team, cached per isolate by jose. */
function accessKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

/**
 * Signature (RS256 only), iss, aud, exp and nbf, then the email against the owner's. Returns the
 * JWT so the local end can check it again for itself.
 */
export async function checkAccessJwt(
  request: Request,
  cfg: AccessConfig,
  keys: JWTVerifyGetKey = accessKeys(cfg.teamDomain),
): Promise<string | undefined> {
  const jwt = accessJwt(request);
  if (jwt === undefined) return undefined;
  try {
    const { payload } = await jwtVerify(jwt, keys, {
      algorithms: ["RS256"],
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
    });
    return typeof payload.email === "string" &&
      payload.email.toLowerCase() === cfg.ownerEmail.toLowerCase()
      ? jwt
      : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of request.cf.tlsClientAuth this reads; Cloudflare sends every one as a string. */
export interface TlsClientAuth {
  readonly certPresented?: string;
  readonly certVerified?: string;
  readonly certRevoked?: string;
  readonly certFingerprintSHA256?: string;
}

/**
 * The client certificate. Every comparison is === against a string: without a certificate the
 * fields still come, as "0", "NONE", "0", and "0" is truthy. certRevoked must equal "0", so a
 * missing field is refused too. `fingerprints` is the secret: comma-separated, at most two.
 */
export function checkLinkIdentity(auth: TlsClientAuth | undefined, fingerprints: string): boolean {
  if (auth === undefined) return false;
  const allowed = fingerprints
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f !== "");
  if (allowed.length === 0 || allowed.length > 2) return false;
  return (
    auth.certPresented === "1" &&
    auth.certVerified === "SUCCESS" &&
    auth.certRevoked === "0" &&
    typeof auth.certFingerprintSHA256 === "string" &&
    allowed.includes(auth.certFingerprintSHA256.toLowerCase())
  );
}
