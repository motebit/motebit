import type { MemoryCandidate } from "@motebit/protocol";
import { SensitivityLevel } from "@motebit/protocol";
import { RedactionEngine } from "./redaction.js";
import { ContentSanitizer } from "./sanitizer.js";

/**
 * MemoryGovernance — controls what the creature is allowed to remember.
 *
 * The invariant: the creature never stores secrets. It classifies memories
 * as ephemeral or persistent, enforces save thresholds, and provides
 * "why did you remember this?" explanations.
 */

export enum MemoryClass {
  /** Ephemeral: kept for the current session, not persisted across restarts. */
  EPHEMERAL = "ephemeral",
  /** Persistent: saved to the memory graph, survives across sessions. */
  PERSISTENT = "persistent",
  /** Rejected: contains secrets or violates policy, never stored. */
  REJECTED = "rejected",
}

export interface MemoryGovernanceConfig {
  /** Minimum confidence threshold for persistent storage (default 0.5) */
  persistenceThreshold: number;
  /** Maximum number of memories formed per turn (default 5) */
  maxMemoriesPerTurn: number;
  /** Enable secret detection — reject memories containing secrets (default true) */
  rejectSecrets: boolean;
}

export const DEFAULT_MEMORY_GOVERNANCE: MemoryGovernanceConfig = {
  persistenceThreshold: 0.5,
  maxMemoriesPerTurn: 5,
  rejectSecrets: true,
};

export interface MemoryDecision {
  candidate: MemoryCandidate;
  memoryClass: MemoryClass;
  reason: string;
}

/** Maximum confidence for memories that contain injection patterns. */
const MAX_INJECTION_CONFIDENCE = 0.3;

export class MemoryGovernor {
  private config: MemoryGovernanceConfig;
  private redaction: RedactionEngine;
  private sanitizer: ContentSanitizer;

  constructor(config?: Partial<MemoryGovernanceConfig>) {
    this.config = { ...DEFAULT_MEMORY_GOVERNANCE, ...config };
    this.redaction = new RedactionEngine();
    this.sanitizer = new ContentSanitizer();
  }

  /** Read-only snapshot of the effective governance config. */
  getConfig(): Readonly<MemoryGovernanceConfig> {
    return this.config;
  }

  /**
   * Evaluate a batch of memory candidates from a turn.
   * Returns decisions for each candidate: persist, make ephemeral, or reject.
   */
  evaluate(candidates: MemoryCandidate[]): MemoryDecision[] {
    const decisions: MemoryDecision[] = [];
    let persistentCount = 0;

    for (const candidate of candidates) {
      // 1. Secret check — never store secrets
      if (this.config.rejectSecrets && this.redaction.containsSecrets(candidate.content)) {
        decisions.push({
          candidate,
          memoryClass: MemoryClass.REJECTED,
          reason: "Contains detected secrets (tokens, keys, passwords). Never stored.",
        });
        continue;
      }

      // 1b. Injection defense — memories with embedded directives get confidence-capped.
      // We don't reject outright (false positives would lose legitimate memories), but
      // capping confidence ensures injected content decays quickly and is deprioritized.
      const scanResult = this.sanitizer.sanitize(candidate.content, "memory:candidate");
      if (scanResult.injectionDetected) {
        const cappedConfidence = Math.min(candidate.confidence, MAX_INJECTION_CONFIDENCE);
        decisions.push({
          candidate: { ...candidate, confidence: cappedConfidence },
          memoryClass:
            cappedConfidence >= this.config.persistenceThreshold
              ? MemoryClass.PERSISTENT
              : MemoryClass.EPHEMERAL,
          reason: `Injection patterns detected (${scanResult.injectionPatterns.length} regex, density=${(scanResult.directiveDensity ?? 0).toFixed(3)}, structural=[${(scanResult.structuralFlags ?? []).join(",")}]). Confidence capped to ${cappedConfidence.toFixed(2)}.`,
        });
        if (cappedConfidence >= this.config.persistenceThreshold) persistentCount++;
        continue;
      }

      // 2. Per-turn limit check
      if (persistentCount >= this.config.maxMemoriesPerTurn) {
        decisions.push({
          candidate,
          memoryClass: MemoryClass.EPHEMERAL,
          reason: `Per-turn memory limit reached (max ${this.config.maxMemoriesPerTurn}). Kept as ephemeral.`,
        });
        continue;
      }

      // 3. Confidence threshold
      if (candidate.confidence < this.config.persistenceThreshold) {
        decisions.push({
          candidate,
          memoryClass: MemoryClass.EPHEMERAL,
          reason: `Confidence ${candidate.confidence.toFixed(2)} below persistence threshold ${this.config.persistenceThreshold}. Kept as ephemeral.`,
        });
        continue;
      }

      // 4. Sensitivity-based classification
      if (candidate.sensitivity === SensitivityLevel.Secret) {
        decisions.push({
          candidate,
          memoryClass: MemoryClass.REJECTED,
          reason: "Sensitivity level is SECRET. Never stored.",
        });
        continue;
      }

      // 5. Passed all checks — persist
      persistentCount++;
      decisions.push({
        candidate,
        memoryClass: MemoryClass.PERSISTENT,
        reason: this.explainWhy(candidate),
      });
    }

    return decisions;
  }

  /**
   * Generate a human-readable explanation for why a memory was stored.
   * This powers the "why did you remember this?" UI.
   */
  private explainWhy(candidate: MemoryCandidate): string {
    const parts: string[] = [];

    if (candidate.confidence >= 0.8) {
      parts.push("High confidence observation");
    } else {
      parts.push("Moderate confidence observation");
    }

    switch (candidate.sensitivity) {
      case SensitivityLevel.Personal:
        parts.push("about personal preferences or details");
        break;
      case SensitivityLevel.Medical:
        parts.push("about health-related information");
        break;
      case SensitivityLevel.Financial:
        parts.push("about financial information");
        break;
      default:
        parts.push("from conversation");
        break;
    }

    return parts.join(" ") + ".";
  }
}
