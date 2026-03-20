// === Task-Aware Capability Routing ===
//
// Metabolic principle: route to the most efficient nutrient source for each task.
// Different task types (conversation, summarization, reflection, etc.) have
// different demands — some need creativity (higher temperature), some need
// precision (lower temperature), some can use smaller/cheaper models.

import type { IntelligenceProvider } from "@motebit/sdk";

// === Task Types ===

export type TaskType =
  | "conversation"
  | "summarization"
  | "reflection"
  | "title_generation"
  | "memory_extraction";

// === Task Profile ===

export interface TaskProfile {
  taskType: TaskType;
  /** Override model for this task type. */
  model?: string;
  /** Override temperature for this task type. */
  temperature?: number;
  /** Override max_tokens for this task type. */
  maxTokens?: number;
}

// === Resolved Config ===

/** The fully-resolved model configuration for a task — no optional fields. */
export interface ResolvedTaskConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

// === Router Configuration ===

export interface TaskRouterConfig {
  /** Default model config (used when no task-specific override exists). */
  default: { model: string; temperature?: number; maxTokens?: number };
  /** Per-task overrides. Only specified fields override the default. */
  overrides?: Partial<
    Record<TaskType, { model?: string; temperature?: number; maxTokens?: number }>
  >;
}

// === Task Router ===

/**
 * Configuration-driven router that maps task types to model configs.
 *
 * Each task type can specify its own model, temperature, and maxTokens.
 * Unspecified fields fall back to the default config, which in turn falls
 * back to sensible defaults (temperature 0.7, maxTokens 4096).
 */
export class TaskRouter {
  constructor(private config: TaskRouterConfig) {}

  /**
   * Get the effective model config for a task type.
   * Falls back to default for unspecified fields.
   */
  resolve(taskType: TaskType): ResolvedTaskConfig {
    const override = this.config.overrides?.[taskType];
    return {
      model: override?.model ?? this.config.default.model,
      temperature: override?.temperature ?? this.config.default.temperature ?? 0.7,
      maxTokens: override?.maxTokens ?? this.config.default.maxTokens ?? 4096,
    };
  }
}

// === Configurable Provider (duck-typed) ===

/**
 * A provider that supports runtime model/temperature/maxTokens switching.
 * CloudProvider and OllamaProvider both implement this interface.
 */
interface ConfigurableProvider extends IntelligenceProvider {
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  setModel(model: string): void;
  setTemperature?(temperature: number): void;
  setMaxTokens?(maxTokens: number): void;
}

function isConfigurable(provider: IntelligenceProvider): provider is ConfigurableProvider {
  return (
    typeof (provider as unknown as Record<string, unknown>).setModel === "function" &&
    typeof (provider as unknown as Record<string, unknown>).model === "string"
  );
}

// === withTaskConfig ===

/**
 * Temporarily apply a resolved task config to a provider, run an async callback,
 * then restore the original config — even if the callback throws.
 *
 * If the provider doesn't support config switching (no `setModel` method),
 * the callback runs with the provider as-is (backward compatible).
 */
export async function withTaskConfig<T>(
  provider: IntelligenceProvider,
  taskConfig: ResolvedTaskConfig,
  fn: (provider: IntelligenceProvider) => Promise<T>,
): Promise<T> {
  if (!isConfigurable(provider)) {
    return fn(provider);
  }

  // Save originals
  const savedModel = provider.model;
  const savedTemperature = provider.temperature;
  const savedMaxTokens = provider.maxTokens;

  try {
    // Apply task config
    provider.setModel(taskConfig.model);
    if (typeof provider.setTemperature === "function") {
      provider.setTemperature(taskConfig.temperature);
    }
    if (typeof provider.setMaxTokens === "function") {
      provider.setMaxTokens(taskConfig.maxTokens);
    }

    return await fn(provider);
  } finally {
    // Restore originals
    provider.setModel(savedModel);
    if (typeof provider.setTemperature === "function") {
      // Restore to saved value; if it was undefined, the provider's generate()
      // will fall back to its built-in default (0.7)
      provider.setTemperature(savedTemperature ?? 0.7);
    }
    if (typeof provider.setMaxTokens === "function") {
      provider.setMaxTokens(savedMaxTokens ?? 4096);
    }
  }
}
