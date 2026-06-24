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

/**
 * Redact the credential-class secrets from a user's outbound content in a
 * ContextPack — `user_message` plus user-role `conversation_history` entries.
 * Pure; returns a shallow copy. Exported for direct unit testing.
 */
export function redactPackForCloudEgress(
  pack: ContextPack,
  redact: (text: string) => string,
): ContextPack {
  return {
    ...pack,
    user_message: redact(pack.user_message),
    ...(pack.conversation_history !== undefined
      ? {
          conversation_history: pack.conversation_history.map((m) =>
            m.role === "user" ? { ...m, content: redact(m.content) } : m,
          ),
        }
      : {}),
  };
}

export interface SecretRedactingProviderOptions {
  /** True when the configured provider runs on-device — redaction is then a no-op. */
  isSovereign: () => boolean;
  /** Credential-class redactor, e.g. `PolicyGate.redactForCloudEgress`. */
  redact: (text: string) => string;
}

export class SecretRedactingProvider implements StreamingProvider {
  constructor(
    private readonly inner: StreamingProvider,
    private readonly opts: SecretRedactingProviderOptions,
  ) {}

  /** Redact the outbound pack unless the provider is sovereign (on-device). */
  private packFor(pack: ContextPack): ContextPack {
    return this.opts.isSovereign() ? pack : redactPackForCloudEgress(pack, this.opts.redact);
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
