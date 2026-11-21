import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";

/** Keys are kept at most this long, and fetched at most once a minute. */
const KEYS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_EVERY_MS = 60 * 1000;
const CLOCK_TOLERANCE_S = 60;
/** setTimeout's longest delay; a later expiry is waited for in several of these. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AccessSettings {
  readonly teamDomain: string;
  readonly aud: string;
  readonly ownerEmail: string;
  /** Where the keys are; Access's own endpoint unless e2e points it at 127.0.0.1. */
  readonly certsUrl: string;
}

export type Verdict =
  | { readonly ok: true; readonly exp: number }
  | { readonly ok: false; readonly reason: "denied" | "keys_unavailable" };

/**
 * Checks a browser's Access JWT on this machine, with keys it fetched itself: the same checks as
 * the Worker (RS256, iss, aud, exp, nbf, the owner's email), so a relay that lies is caught.
 */
export class AccessVerifier {
  private keys: { set: ReturnType<typeof createLocalJWKSet>; at: number } | undefined;
  private lastFetch = -Infinity;

  constructor(
    private readonly s: AccessSettings,
    private readonly fetchJson: (url: string) => Promise<unknown>,
    private readonly now: () => number,
  ) {}

  get available(): boolean {
    return this.keys !== undefined && this.now() - this.keys.at < KEYS_MAX_AGE_MS;
  }

  /** Fetches unless it did in the last minute; false when there are still no usable keys. */
  async refresh(): Promise<boolean> {
    if (this.now() - this.lastFetch < FETCH_EVERY_MS) return this.available;
    this.lastFetch = this.now();
    try {
      const jwks = await this.fetchJson(this.s.certsUrl);
      this.keys = { set: createLocalJWKSet(jwks as JSONWebKeySet), at: this.now() };
    } catch {
      // Kept as they were: still usable until they are a day old.
    }
    return this.available;
  }

  async verify(jwt: string): Promise<Verdict> {
    if (!this.available && !(await this.refresh()))
      return { ok: false, reason: "keys_unavailable" };
    let verdict = await this.check(jwt);
    // A kid not seen yet: the keys may have rotated. One refetch, at most once a minute.
    if (verdict === "unknown_kid" && (await this.refresh())) verdict = await this.check(jwt);
    return verdict === "unknown_kid" ? { ok: false, reason: "denied" } : verdict;
  }

  private async check(jwt: string): Promise<Verdict | "unknown_kid"> {
    const set = this.keys?.set;
    if (set === undefined) return { ok: false, reason: "keys_unavailable" };
    try {
      const { payload } = await jwtVerify(jwt, set, {
        algorithms: ["RS256"],
        issuer: `https://${this.s.teamDomain}`,
        audience: this.s.aud,
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: new Date(this.now()),
      });
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
      if (email !== this.s.ownerEmail.toLowerCase() || typeof payload.exp !== "number")
        return { ok: false, reason: "denied" };
      return { ok: true, exp: payload.exp * 1000 };
    } catch (err) {
      return err instanceof errors.JWKSNoMatchingKey
        ? "unknown_kid"
        : { ok: false, reason: "denied" };
    }
  }
}

export interface Registration {
  readonly conn: string;
  /** When the browser's login ends, in ms. */
  readonly exp: number;
  hello: boolean;
  subscribed?: string;
  readonly country?: string;
  readonly ua?: string;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The browser connections that passed the check. One the timer drops at its exp is gone from
 * every list at once, so nothing more is sent to it (S3-1). The JWT itself is not kept.
 */
export class Registry {
  private readonly regs = new Map<string, Registration>();
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly timer: Timers,
    private readonly now: () => number,
    private readonly expired: (conn: string) => void,
  ) {}

  add(reg: Omit<Registration, "hello">): void {
    this.remove(reg.conn);
    this.regs.set(reg.conn, { ...reg, hello: false });
    this.arm(reg.conn, reg.exp);
  }

  private arm(conn: string, exp: number): void {
    const wait = exp - this.now();
    this.timers.set(
      conn,
      this.timer.setTimeout(
        () => {
          // Cut short by setTimeout's limit: wait again for the rest.
          if (this.now() < exp) return this.arm(conn, exp);
          this.remove(conn);
          this.expired(conn);
        },
        Math.max(0, Math.min(wait, MAX_TIMER_MS)),
      ),
    );
  }

  get(conn: string): Registration | undefined {
    return this.regs.get(conn);
  }

  /** Still within its login: checked again before anything that acts. */
  valid(conn: string): boolean {
    const reg = this.regs.get(conn);
    return reg !== undefined && this.now() < reg.exp;
  }

  remove(conn: string): void {
    const t = this.timers.get(conn);
    if (t !== undefined) this.timer.clearTimeout(t);
    this.timers.delete(conn);
    this.regs.delete(conn);
  }

  /** On every link connect and disconnect: the relay's browsers are not ours anymore. */
  clear(): void {
    for (const conn of this.regs.keys()) this.remove(conn);
  }

  /** Connections that said hello and are within their login: the ones a broadcast goes to. */
  ready(): Registration[] {
    const now = this.now();
    return [...this.regs.values()].filter((r) => r.hello && now < r.exp);
  }

  get size(): number {
    return this.regs.size;
  }
}
