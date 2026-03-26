import type {
  AllocationId,
  GoalId,
  MotebitId,
  BudgetAllocation,
  CapabilityPrice,
} from "@motebit/sdk";

export interface AllocationRequest {
  goal_id: GoalId;
  candidate_motebit_id: MotebitId;
  estimated_cost: number;
  currency: string;
  risk_factor?: number;
}

/**
 * Pure: request + available → BudgetAllocation | null
 * Lock amount = estimated_cost * (1 + risk_factor * 0.2), capped at available.
 * Returns null if insufficient funds.
 */
export function allocateBudget(
  request: AllocationRequest,
  available: number,
  allocationId: AllocationId,
): BudgetAllocation | null {
  const risk = request.risk_factor ?? 1.0;
  const lockAmount = request.estimated_cost * (1 + risk * 0.2);
  const capped = Math.min(lockAmount, available);

  if (capped < request.estimated_cost) return null;

  return {
    allocation_id: allocationId,
    goal_id: request.goal_id,
    candidate_motebit_id: request.candidate_motebit_id,
    amount_locked: capped,
    currency: request.currency,
    created_at: Date.now(),
    status: "locked",
  };
}

/** Pure: pricing + capabilities → estimated cost */
export function estimateCost(
  pricing: CapabilityPrice[],
  capabilities: string[],
): { amount: number; currency: string } {
  let amount = 0;
  let currency = "USD";
  for (const cap of capabilities) {
    const price = pricing.find((p) => p.capability === cap);
    if (price) {
      amount += price.unit_cost;
      currency = price.currency;
    }
  }
  return { amount, currency };
}

export interface CollaborativeBudgetAllocation {
  motebit_id: MotebitId;
  estimated_cost: number;
  currency: string;
}

/**
 * Pure: allocate budget across participants in a collaborative plan.
 * Sums estimated cost per participant from their assigned steps × pricing.
 * Returns one allocation per participant, or empty array if insufficient budget.
 */
export function allocateCollaborativeBudget(
  _steps: Array<{ ordinal: number; assigned_motebit_id?: string }>,
  participants: Array<{ motebit_id: string; assigned_steps: number[] }>,
  pricing: Map<string, CapabilityPrice[]>,
  available: number,
): CollaborativeBudgetAllocation[] {
  const allocations: CollaborativeBudgetAllocation[] = [];
  let totalCost = 0;

  for (const participant of participants) {
    const participantPricing = pricing.get(participant.motebit_id) ?? [];
    let cost = 0;
    let currency = "USD";

    for (const _ordinal of participant.assigned_steps) {
      // Each assigned step incurs the participant's per-task cost
      for (const price of participantPricing) {
        if (price.per === "task") {
          cost += price.unit_cost;
          currency = price.currency;
        }
      }
    }

    totalCost += cost;
    allocations.push({
      motebit_id: participant.motebit_id as MotebitId,
      estimated_cost: cost,
      currency,
    });
  }

  if (totalCost > available) return [];
  return allocations;
}
