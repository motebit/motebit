/**
 * The relay's auth posture — ONE decision, every entry point.
 *
 * Whether a relay may run, and with what master-token posture, is decided
 * here and nowhere else: `server.ts` (through `buildRelayConfigFromEnv`), a
 * library embedder of `createSyncRelay`, and the CLI's `motebit relay up`
 * all call {@link resolveRelayAuthPosture}. The rule lived in three places
 * once and they disagreed — `relay up` honoured the insecure opt-in under
 * `NODE_ENV=production` and booted open.
 *
 * Boot table (env → outcome):
 *   - `MOTEBIT_RELAY_INSECURE_NO_AUTH` set to a value that is neither on nor
 *     off → refuse (a misconfiguration, never guessed at);
 *   - the opt-in on, and `NODE_ENV` (trimmed, lowercased) not exactly
 *     `development` or `test` → refuse, token or not. Every other value,
 *     unset included, is production for this decision;
 *   - a non-blank `MOTEBIT_API_TOKEN` → the token posture;
 *   - the opt-in on (development / test) → the insecure-dev posture;
 *   - otherwise the caller's `fallbackToken` (the CLI's owner-only token file)
 *     → the token posture; with none → refuse.
 *
 * The insecure-dev posture is a CAPABILITY, not a flag: only this module
 * mints one (an ES private field the constructor demands a module-private
 * key for), and the middleware opens the master-token routes only for a
 * value {@link isInsecureDevPosture} recognises. A config that merely lacks a
 * token — or carries a hand-built `{ kind: "insecure-dev" }` — gets sealed
 * gates (401), never open ones.
 */
import { randomBytes } from "node:crypto";

/** Env reader shape: a plain map, so tests drive it with crafted envs. */
export type RelayAuthEnv = Readonly<Record<string, string | undefined>>;

export interface RelayTokenPosture {
  readonly kind: "token";
  readonly token: string;
  /** `env` — `MOTEBIT_API_TOKEN`; `fallback` — the caller's `fallbackToken`. */
  readonly source: "env" | "fallback";
}

const INSECURE_POSTURE_KEY = Symbol("relay-insecure-dev-posture");

/** The explicit local-development opt-in. Mint only through {@link resolveRelayAuthPosture}. */
export class RelayInsecureDevPosture {
  readonly kind = "insecure-dev" as const;
  readonly #minted = true;
  /** The `NODE_ENV` value (normalized) the opt-in was honoured under. */
  readonly nodeEnv: "development" | "test";
  constructor(key: symbol, nodeEnv: "development" | "test") {
    if (key !== INSECURE_POSTURE_KEY) {
      throw new Error("RelayInsecureDevPosture is minted only by resolveRelayAuthPosture");
    }
    this.nodeEnv = nodeEnv;
  }
  static isMinted(value: unknown): boolean {
    return typeof value === "object" && value !== null && #minted in value;
  }
}

export type RelayAuthPosture = RelayTokenPosture | RelayInsecureDevPosture;

/** Thrown when the env does not admit a relay boot. */
export class RelayAuthRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAuthRefusal";
  }
}

export interface ResolveRelayAuthPostureOptions {
  /**
   * A token to fall back to when `MOTEBIT_API_TOKEN` is unset and no opt-in
   * is requested (the CLI's generated owner-only token file). Never consulted
   * when the env refuses or opts in.
   */
  fallbackToken?: () => string;
}

// The relay's one boolean vocabulary (`env.ts` `parseBoolEnv`): `true`/`1` on,
// `false`/`0` off, empty = unset; anything else refuses.
const ON = new Set(["1", "true"]);
const OFF = new Set(["", "0", "false"]);

/** `development` / `test` exactly (trimmed, lowercased); anything else is production. */
function devNodeEnv(raw: string | undefined): "development" | "test" | null {
  const v = raw?.trim().toLowerCase();
  return v === "development" || v === "test" ? v : null;
}

/** The one decision. Throws {@link RelayAuthRefusal} when the relay must not boot. */
export function resolveRelayAuthPosture(
  env: RelayAuthEnv,
  opts: ResolveRelayAuthPostureOptions = {},
): RelayAuthPosture {
  const flagRaw = env["MOTEBIT_RELAY_INSECURE_NO_AUTH"];
  let optIn = false;
  if (flagRaw !== undefined) {
    const flag = flagRaw.trim().toLowerCase();
    if (ON.has(flag)) optIn = true;
    else if (!OFF.has(flag)) {
      throw new RelayAuthRefusal(
        `MOTEBIT_RELAY_INSECURE_NO_AUTH=${JSON.stringify(flagRaw)} is not a recognised value: ` +
          "unset it (or set MOTEBIT_API_TOKEN). The relay refuses to guess whether its " +
          "master-token routes should be open.",
      );
    }
  }
  const dev = devNodeEnv(env["NODE_ENV"]);
  if (optIn && dev === null) {
    throw new RelayAuthRefusal(
      `MOTEBIT_RELAY_INSECURE_NO_AUTH is refused under NODE_ENV=${JSON.stringify(env["NODE_ENV"] ?? "")}: ` +
        "the open-relay opt-in is honoured only when NODE_ENV is exactly `development` or `test` " +
        "(any other value, unset included, is production). Unset it and set MOTEBIT_API_TOKEN.",
    );
  }
  const token = env["MOTEBIT_API_TOKEN"]?.trim();
  if (token != null && token !== "") return { kind: "token", token, source: "env" };
  if (optIn && dev !== null) return new RelayInsecureDevPosture(INSECURE_POSTURE_KEY, dev);
  if (opts.fallbackToken) {
    const fallback = opts.fallbackToken().trim();
    if (fallback !== "") return { kind: "token", token: fallback, source: "fallback" };
  }
  throw new RelayAuthRefusal(
    "MOTEBIT_API_TOKEN is required: the relay refuses to start without a master token, " +
      "because every admin, export and sync route is gated by it. Set MOTEBIT_API_TOKEN to a " +
      "non-empty secret. For local development only, MOTEBIT_RELAY_INSECURE_NO_AUTH=1 with " +
      "NODE_ENV=development starts the relay with those routes open.",
  );
}

/** Whether `value` is an insecure-dev posture minted by {@link resolveRelayAuthPosture}. */
export function isInsecureDevPosture(value: unknown): value is RelayInsecureDevPosture {
  return RelayInsecureDevPosture.isMinted(value);
}

/**
 * The token every master-token gate is installed from. A configured token is
 * itself; with none, `undefined` (gates open) ONLY for a minted insecure-dev
 * posture — otherwise a fresh random secret no caller holds, so every gate
 * installs and answers 401. Fail-closed by construction: an absent token is
 * never by itself an open relay.
 */
export function masterGateToken(
  apiToken: string | undefined,
  posture: unknown,
): string | undefined {
  if (apiToken != null && apiToken.trim() !== "") return apiToken;
  if (isInsecureDevPosture(posture)) return undefined;
  return randomBytes(32).toString("hex");
}
