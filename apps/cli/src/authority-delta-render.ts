/**
 * Owner-side rendering of `AuthorityDelta` — every refusal a typed
 * repair instruction (the gate-repair-instructions contract in the
 * product; sibling of grant-preflight's renderer). This is the OWNER
 * half of the asymmetry: the model saw only the coarse reason; the
 * sovereign sees exactly what's missing and how to mint it.
 */

import type { AuthorityDelta } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

export function renderAuthorityDelta(toolName: string, delta: AuthorityDelta): string[] {
  const lines: string[] = [`  [${toolName} refused — missing authority:]`];

  if (delta.terminal != null) {
    lines.push(
      `    ✗ grant ${delta.terminal} — terminal; mint a new grant: motebit grant create …`,
    );
    return lines;
  }
  if (delta.missing_scope != null && delta.missing_scope.length > 0) {
    lines.push(
      `    ✗ scope: grant does not cover ${delta.missing_scope.join(", ")}`,
      `      → mint a grant with --scope ${delta.missing_scope.join(",")}`,
    );
  }
  if (delta.requires_verified_grant === true) {
    lines.push(
      `    ✗ standing authority: ${riskName(delta.required_risk)} needs a verified grant or your live approval`,
      `      → motebit grant create --scope ${toolName} …, then relaunch with --grant <id>`,
    );
  } else if (delta.required_risk != null && delta.posture_ceiling != null) {
    lines.push(
      `    ✗ posture: action is ${riskName(delta.required_risk)}, your governance ceiling is ${riskName(delta.posture_ceiling)}`,
      `      → a deliberate posture change permits it: governance.approvalPreset in ~/.motebit/config.json`,
    );
  }
  if (delta.spend_overage_micro != null) {
    lines.push(
      `    ✗ spend: exceeds remaining ceiling by $${(delta.spend_overage_micro / 1_000_000).toFixed(4)}`,
      `      → a new grant with the difference covers it`,
    );
  }
  if (delta.not_before != null) {
    lines.push(`    ✗ window: headroom returns ${new Date(delta.not_before).toISOString()}`);
  }
  if (delta.quorum_shortfall != null) {
    lines.push(`    ✗ quorum: ${delta.quorum_shortfall} more approval(s) required`);
  }
  return lines;
}

function riskName(risk: RiskLevel | undefined): string {
  return risk != null ? RiskLevel[risk] : "this action";
}
