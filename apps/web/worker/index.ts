import { checkAccessJwt, checkLinkIdentity, type TlsClientAuth } from "./identity.ts";
import { CONN_HEADER, COUNTRY_HEADER, JWT_HEADER, ROLE_HEADER, UA_HEADER } from "./relay.ts";

export { Relay } from "./relay.ts";

/** The same words for every failed check: which one failed is not said. */
const FORBIDDEN = "forbidden";

const forbidden = () => new Response(FORBIDDEN, { status: 403 });
const notFound = () => new Response("not found", { status: 404 });

const isUpgrade = (request: Request) =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

/**
 * The relay's request to the DO, built fresh: nothing the client sent reaches it except what the
 * checks vouch for.
 */
function toRelay(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
  return stub.fetch(new Request(request.url, { headers: { Upgrade: "websocket", ...headers } }));
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/ws") {
    if (url.hostname !== env.APP_HOST) return notFound();
    if (!isUpgrade(request) || request.headers.get("Origin") !== `https://${env.APP_HOST}`)
      return forbidden();
    const jwt = await checkAccessJwt(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      ownerEmail: env.OWNER_EMAIL,
    });
    if (jwt === undefined) return forbidden();
    const cf = request.cf as { country?: unknown } | undefined;
    const ua = request.headers.get("User-Agent");
    return toRelay(request, env, {
      [ROLE_HEADER]: "browser",
      [CONN_HEADER]: crypto.randomUUID(),
      [JWT_HEADER]: jwt,
      ...(typeof cf?.country === "string" ? { [COUNTRY_HEADER]: cf.country } : {}),
      ...(ua === null ? {} : { [UA_HEADER]: ua }),
    });
  }
  if (url.pathname === "/link") {
    if (url.hostname !== env.LINK_HOST) return notFound();
    const cf = request.cf as { tlsClientAuth?: TlsClientAuth } | undefined;
    if (!isUpgrade(request) || !checkLinkIdentity(cf?.tlsClientAuth, env.LINK_CERT_FINGERPRINTS))
      return forbidden();
    return toRelay(request, env, { [ROLE_HEADER]: "local" });
  }
  return env.ASSETS.fetch(request);
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
