/**
 * Fixtures for the repo-task run tests: a principal F, an agent A, a scope,
 * a grant F→A bound to it, a tick, in-memory ports and a scripted model.
 * Every key is generated in-test (ephemeral, never stored).
 */
import { vi } from "vitest";
import {
  bytesToHex,
  generateKeypair,
  signDelegation,
  signDelegationRevocation,
  signStandingDelegation,
  subjectBindingDigest,
} from "@motebit/crypto";
import type {
  DelegationRevocation,
  DelegationToken,
  KeyPair,
  StandingDelegation,
} from "@motebit/crypto";
import type { StreamingProvider } from "@motebit/ai-core";
import type { RepoTaskScope } from "@motebit/protocol";
import type { AIResponse, ContextPack, ToolCall } from "@motebit/sdk";

import type {
  RepoPathWriter,
  RepoPathWriteResult,
  RepoTaskAgent,
  RepoTaskAuthorityBundle,
  RepoTreeEntry,
  RepoTreeReader,
} from "../repo-task/index.js";

export const REPO = "motebit/motebit";
export const GRANT_ID = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
export const BOTH = "repo_read_blob,repo_write_path";
export const HOUR = 3_600_000;
export const T0 = 1_900_000_000_000;
export const F_ID = "motebit-principal-f";
export const A_ID = "motebit-agent-a";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Body<T> = Mutable<Omit<T, "signature" | "suite">>;

export interface Keys {
  f: KeyPair;
  a: KeyPair;
  x: KeyPair;
}

let cached: Keys | null = null;
export async function keys(): Promise<Keys> {
  if (!cached)
    cached = { f: await generateKeypair(), a: await generateKeypair(), x: await generateKeypair() };
  return cached;
}
export const hex = (k: KeyPair): string => bytesToHex(k.publicKey);

export interface BundleOpts {
  scope?: (s: Mutable<RepoTaskScope> & { allowed_paths: string[] }) => void;
  /** Mutate the scope AFTER the grant binds it (a scope the grant does not bind). */
  scopeAfterBinding?: (s: Mutable<RepoTaskScope> & { allowed_paths: string[] }) => void;
  grant?: (g: Body<StandingDelegation>) => void;
  grantSigner?: (k: Keys) => KeyPair;
  tick?: (t: Body<DelegationToken>) => void;
  tickSigner?: (k: Keys) => KeyPair;
  tickSigned?: (t: Mutable<DelegationToken>) => void;
  revocations?: (
    k: Keys,
    grant: StandingDelegation,
  ) => Promise<DelegationRevocation[]> | DelegationRevocation[];
  revocationFailures?: string[];
  principal?: (k: Keys) => { motebit_id: string; public_key: string };
  isPathPermitted?: (p: string) => boolean;
}

export async function makeBundle(opts: BundleOpts = {}): Promise<RepoTaskAuthorityBundle> {
  const k = await keys();
  const scope = {
    schema: "motebit.repo-task-scope.v1" as const,
    spec: "motebit/repo-task-scope@1.0" as const,
    repo: REPO,
    base_ref: "main" as const,
    object_format: "sha1" as const,
    allowed_paths: ["docs/a.md"],
    max_changed_files: 1,
    task: "Fix the typo in docs/a.md.",
  } as Mutable<RepoTaskScope> & { allowed_paths: string[] };
  opts.scope?.(scope);
  const binding = {
    schema: "motebit.subject-binding.v1" as const,
    artifact_schema: "motebit.repo-task-scope.v1",
    digest_method: "jcs-sha256-hex" as const,
    digest: await subjectBindingDigest(scope),
  };
  opts.scopeAfterBinding?.(scope);
  const grantBody: Body<StandingDelegation> = {
    grant_id: GRANT_ID,
    delegator_id: F_ID,
    delegator_public_key: hex(k.f),
    delegate_id: A_ID,
    delegate_public_key: hex(k.a),
    scope: BOTH,
    subject: "repo-change",
    subject_binding: binding,
    cadence_ms: 24 * HOUR,
    issued_at: T0,
    not_before: null,
    expires_at: T0 + 24 * HOUR,
    max_token_ttl_ms: HOUR,
  };
  opts.grant?.(grantBody);
  const grant = await signStandingDelegation(grantBody, (opts.grantSigner?.(k) ?? k.f).privateKey);
  const tickBody: Body<DelegationToken> = {
    delegator_id: grantBody.delegator_id,
    delegator_public_key: grantBody.delegator_public_key,
    delegate_id: grantBody.delegate_id,
    delegate_public_key: grantBody.delegate_public_key,
    scope: BOTH,
    issued_at: T0,
    expires_at: T0 + HOUR,
    grant_id: GRANT_ID,
  };
  opts.tick?.(tickBody);
  const tick: Mutable<DelegationToken> = {
    ...(await signDelegation(tickBody, (opts.tickSigner?.(k) ?? k.f).privateKey)),
  };
  opts.tickSigned?.(tick);
  return {
    scope,
    grant,
    tick,
    revocations: {
      set: (await opts.revocations?.(k, grant)) ?? [],
      failures: opts.revocationFailures ?? [],
      readAt: "a".repeat(40),
    },
    principal: opts.principal?.(k) ?? { motebit_id: F_ID, public_key: hex(k.f) },
    expectedRepo: REPO,
    isPathPermitted: opts.isPathPermitted ?? (() => true),
  };
}

export async function revokeGrant(
  k: Keys,
  grant: StandingDelegation,
): Promise<DelegationRevocation> {
  return signDelegationRevocation(
    {
      grant_id: grant.grant_id,
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      revoked_at: T0 + 1,
    },
    k.f.privateKey,
  );
}

export async function agentA(over?: Partial<RepoTaskAgent>): Promise<RepoTaskAgent> {
  const k = await keys();
  return {
    motebitId: A_ID,
    deviceId: "dev-a",
    privateKey: k.a.privateKey,
    publicKey: k.a.publicKey,
    ...over,
  };
}

/** The tip's tree, in memory. Counts every lookup and read. */
export class MemTree implements RepoTreeReader {
  readonly lookups: string[] = [];
  readonly reads: string[] = [];
  failReads = false;
  constructor(
    private readonly files: Map<string, RepoTreeEntry & { bytes?: Uint8Array }> = new Map(),
  ) {}
  static withFile(path: string, text: string, mode = "100644"): MemTree {
    return new MemTree(
      new Map([
        [path, { kind: "blob", mode, oid: "1".repeat(40), bytes: new TextEncoder().encode(text) }],
      ]),
    );
  }
  set(path: string, entry: RepoTreeEntry & { bytes?: Uint8Array }): this {
    this.files.set(path, entry);
    return this;
  }
  lookup(path: string): Promise<RepoTreeEntry | null> {
    this.lookups.push(path);
    const e = this.files.get(path);
    return Promise.resolve(e ? { kind: e.kind, mode: e.mode, oid: e.oid } : null);
  }
  readBlob(oid: string): Promise<Uint8Array> {
    this.reads.push(oid);
    if (this.failReads) return Promise.reject(new Error("object store unreadable"));
    for (const e of this.files.values())
      if (e.oid === oid && e.bytes) return Promise.resolve(e.bytes);
    return Promise.reject(new Error(`no blob ${oid}`));
  }
}

/** The worktree writer, in memory. Records every write it was asked for. */
export class MemWriter implements RepoPathWriter {
  readonly calls: Array<{ path: string; text: string }> = [];
  readonly files = new Map<string, string>();
  refuse: RepoPathWriteResult | null = null;
  throwOnWrite = false;
  write(path: string, content: Uint8Array): Promise<RepoPathWriteResult> {
    const text = new TextDecoder().decode(content);
    this.calls.push({ path, text });
    if (this.throwOnWrite) return Promise.reject(new Error("disk full"));
    if (this.refuse) return Promise.resolve(this.refuse);
    this.files.set(path, text);
    return Promise.resolve({ ok: true });
  }
}

/** One model turn: either tool calls or a final answer. */
export type Turn = ToolCall[] | string;

/**
 * A scripted model: each generateStream consumes the next turn and records
 * the pack it was sent. `onCall` runs before each response (e.g. to advance a clock).
 */
export function scriptedModel(
  turns: Turn[],
  onCall?: (n: number, pack: ContextPack) => void,
): StreamingProvider & { packs: ContextPack[] } {
  const packs: ContextPack[] = [];
  let i = 0;
  const respond = (pack: ContextPack): AIResponse => {
    packs.push(pack);
    onCall?.(packs.length, pack);
    const t = turns[i++] ?? "done";
    return typeof t === "string"
      ? { text: t, confidence: 1, memory_candidates: [], state_updates: {} }
      : { text: "", confidence: 1, memory_candidates: [], state_updates: {}, tool_calls: t };
  };
  return {
    packs,
    model: "model-1",
    setModel: vi.fn(),
    generate: vi.fn(async (pack: ContextPack) => respond(pack)),
    estimateConfidence: vi.fn(async () => 1),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(pack: ContextPack) {
      const response = respond(pack);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

export const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  args,
});

let seq = 0;
export const ids = (): string => `id-${++seq}`;
