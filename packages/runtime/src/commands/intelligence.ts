/** Intelligence commands: gradient, reflect. */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";
import { narrateEconomicConsequences } from "@motebit/gradient";

export function cmdGradient(runtime: MotebitRuntime): CommandResult {
  const g = runtime.getGradient();
  if (!g) return { summary: "No gradient data yet." };

  const gradientSummary = runtime.getGradientSummary();
  const summary = `Gradient ${g.gradient.toFixed(3)} (${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(3)}) — ${gradientSummary.posture}`;

  const detailLines: string[] = [];
  if (gradientSummary.snapshotCount > 0) {
    detailLines.push(gradientSummary.trajectory);
    detailLines.push(gradientSummary.overall);
    if (gradientSummary.strengths.length > 0)
      detailLines.push(`Strengths: ${gradientSummary.strengths.join("; ")}`);
    if (gradientSummary.weaknesses.length > 0)
      detailLines.push(`Weaknesses: ${gradientSummary.weaknesses.join("; ")}`);
  }

  const econ = narrateEconomicConsequences(g);
  if (econ.length > 0) {
    detailLines.push("");
    detailLines.push("Economic position:");
    for (const c of econ) detailLines.push(`  - ${c}`);
  }

  const lastRef = runtime.getLastReflection();
  if (lastRef?.selfAssessment) {
    detailLines.push("");
    detailLines.push(`Last reflection: ${lastRef.selfAssessment}`);
  }

  return { summary, detail: detailLines.join("\n"), data: { gradient: g } };
}

export async function cmdReflect(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.reflect();
  const summary = result.selfAssessment || "Reflection complete.";

  const detailLines: string[] = [];
  if (result.insights.length > 0) {
    detailLines.push("Insights:");
    for (const i of result.insights) detailLines.push(`  - ${i}`);
  }
  if (result.planAdjustments.length > 0) {
    detailLines.push("Adjustments:");
    for (const a of result.planAdjustments) detailLines.push(`  - ${a}`);
  }
  if (result.patterns.length > 0) {
    detailLines.push("Recurring patterns:");
    for (const p of result.patterns) detailLines.push(`  - ${p}`);
  }

  return {
    summary,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    data: {
      insights: result.insights,
      adjustments: result.planAdjustments,
      patterns: result.patterns,
    },
  };
}
