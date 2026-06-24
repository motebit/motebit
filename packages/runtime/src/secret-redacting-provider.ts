/**
 * SecretRedactingProvider — masks high-precision credential-class secrets a user
 * typed into an UNMARKED cloud session before they reach the model.
 *
 * The sensitivity egress gate (`assertSensitivityPermitsAiCall`) blocks an entire
 * call when the SESSION tier is medical/financial/secret. But session sensitivity
 * is user-set (+ sensitive-slab-source) — the system does not auto-classify the
 * content of a user's own live message. So a credential typed directly into a
 * session that is still at `none` would otherwise reach a cloud model. This
 * decorator is the additive deterministic floor for that case: it redacts the
 * credential-class subset (`redactForCloudEgress` — keys, tokens, JWTs, PEM keys,
 * seed phrases, connection strings, passwords; NOT SSN/cards/bare-base64, which a
 * user often legitimately uses) from the outbound payload.
 *
 * Boundaries that keep it honest:
 *  - **No-op on a SOVEREIGN (on-device) provider** — nothing leaves the device, and
 *    the user's raw input is kept verbatim.
 *  - **Only the cloud-bound payload is touched**, never the local conversation
 *    transcript — this redacts `ContextPack.user_message` and user-role
 *    `conversation_history` entries on their way to the provider, leaving the
 *    persisted history intact.
 *  - Other roles (assistant/tool) and other pack fields are untouched: tool
 *    results are already redacted upstream, memories are sensitivity-ceiling
 *    filtered + secret-blocked at formation.
 *
 * The model almost never needs to SEE a raw credential (agents use keys via the
 * credential/tool path), so masking protects without breaking the request.
 * Doctrine: docs/doctrine/security-boundaries.md ("Obvious secrets in an unmarked
 * live conversation").
 */
import type { StreamingProvider } from "@motebit/ai-core";
import type { ContextPack, AIResponse, MemoryCandidate } from "@motebit/sdk";

/** A credential-class redactor: masks secrets and reports what it masked. */
export type CloudEgressRedactor = (text: string) => {
  text: string;
  redactionCount: number;
  labels: string[];
};

export interface PackRedactionResult {
  pack: ContextPack;
  /** Total credential-class spans masked across the user-authored fields. */
  redactedCount: number;
  /** Distinct credential-class label names that fired — content-free audit metadata. */
  labels: string[];
}

/**
 * Redact the credential-class secrets from a user's outbound content in a
 * ContextPack — `user_message` plus user-role `conversation_history` entries —
 * and report the aggregate count + distinct labels (for the audit event). Pure;
 * the returned pack is a shallow copy, the original is not mutated. Exported for
 * direct unit testing.
 */
export function redactPackForCloudEgress(
  pack: ContextPack,
  redact: CloudEgressRedactor,
): PackRedactionResult {
  let redactedCount = 0;
  const labels = new Set<string>();
  const apply = (text: string): string => {
    const r = redact(text);
    redactedCount += r.redactionCount;
    for (const l of r.labels) labels.add(l);
    return r.text;
  };
  const newPack: ContextPack = {
    ...pack,
    user_message: apply(pack.user_message),
    ...(pack.conversation_history !== undefined
      ? {
          conversation_history: pack.conversation_history.map((m) =>
            m.role === "user" ? { ...m, content: apply(m.content) } : m,
          ),
        }
      : {}),
  };
  return { pack: newPack, redactedCount, labels: [...labels] };
}

export interface SecretRedactingProviderOptions {
  /** True when the configured provider runs on-device — redaction is then a no-op. */
  isSovereign: () => boolean;
  /** Credential-class redactor, e.g. `PolicyGate.redactForCloudEgress`. */
  redact: CloudEgressRedactor;
  /**
   * Called ONLY when a redaction actually fired, with content-free metadata
   * (count + credential-class label names, never the secret). The runtime wires
   * this to emit a `SecretRedactedFromEgress` audit event.
   */
  onRedacted?: (info: { count: number; labels: string[] }) => void;
}

export class SecretRedactingProvider implements StreamingProvider {
  constructor(
    private readonly inner: StreamingProvider,
    private readonly opts: SecretRedactingProviderOptions,
  ) {}

  /** Redact the outbound pack unless the provider is sovereign (on-device). */
  private packFor(pack: ContextPack): ContextPack {
    if (this.opts.isSovereign()) return pack;
    const {
      pack: redacted,
      redactedCount,
      labels,
    } = redactPackForCloudEgress(pack, this.opts.redact);
    if (redactedCount > 0) this.opts.onRedacted?.({ count: redactedCount, labels });
    return redacted;
  }

  get model(): string {
    return this.inner.model;
  }
  get temperature(): number | undefined {
    return this.inner.temperature;
  }
  get maxTokens(): number | undefined {
    return this.inner.maxTokens;
  }
  setModel(model: string): void {
    this.inner.setModel(model);
  }
  setTemperature(temperature: number | undefined): void {
    this.inner.setTemperature?.(temperature);
  }
  setMaxTokens(maxTokens: number): void {
    this.inner.setMaxTokens?.(maxTokens);
  }
  generate(pack: ContextPack): Promise<AIResponse> {
    return this.inner.generate(this.packFor(pack));
  }
  generateStream(
    pack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    return this.inner.generateStream(this.packFor(pack));
  }
  estimateConfidence(): Promise<number> {
    return this.inner.estimateConfidence();
  }
  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return this.inner.extractMemoryCandidates(response);
  }
}
