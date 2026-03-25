/**
 * Service Listing & Market query routes.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { asMotebitId, asListingId } from "@motebit/sdk";
import { graphRankCandidates } from "@motebit/market";
import type { TaskRouter } from "./task-routing.js";

export interface ListingsDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  taskRouter: TaskRouter;
}

export function registerListingsRoutes(deps: ListingsDeps): void {
  const { app, moteDb, taskRouter } = deps;

  app.post("/api/v1/agents/:motebitId/listing", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot modify another agent's listing" });
    }
    const body = await c.req.json<{
      capabilities?: string[];
      pricing?: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
      sla?: { max_latency_ms?: number; availability_guarantee?: number };
      description?: string;
      pay_to_address?: string;
      regulatory_risk?: number;
    }>();

    const now = Date.now();
    moteDb.db.prepare("DELETE FROM relay_service_listings WHERE motebit_id = ?").run(motebitId);

    const listingId = asListingId(`ls-${crypto.randomUUID()}`);
    moteDb.db
      .prepare(
        `INSERT INTO relay_service_listings
         (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, pay_to_address, regulatory_risk, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        listingId,
        motebitId,
        JSON.stringify(body.capabilities ?? []),
        JSON.stringify(body.pricing ?? []),
        body.sla?.max_latency_ms ?? 5000,
        body.sla?.availability_guarantee ?? 0.99,
        body.description ?? "",
        body.pay_to_address ?? null,
        body.regulatory_risk ?? null,
        now,
      );

    return c.json({ listing_id: listingId, updated_at: now }, 200);
  });

  app.get("/api/v1/agents/:motebitId/listing", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const row = moteDb.db
      .prepare(`SELECT * FROM relay_service_listings WHERE motebit_id = ?`)
      .get(motebitId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "No service listing found" });
    }

    return c.json({
      listing_id: row.listing_id,
      motebit_id: row.motebit_id,
      capabilities: JSON.parse(row.capabilities as string) as string[],
      pricing: JSON.parse(row.pricing as string) as unknown[],
      sla: {
        max_latency_ms: row.sla_max_latency_ms,
        availability_guarantee: row.sla_availability,
      },
      description: row.description,
      updated_at: row.updated_at,
    });
  });

  app.get("/api/v1/market/revenue", (c) => {
    const days = Math.min(parseInt(c.req.query("days") ?? "30", 10) || 30, 365);
    const since = Date.now() - days * 86_400_000;

    const totals = moteDb.db
      .prepare(
        `SELECT
           COUNT(*) AS settlement_count,
           COALESCE(SUM(amount_settled), 0) AS total_settled,
           COALESCE(SUM(platform_fee), 0) AS total_platform_fees,
           COALESCE(SUM(amount_settled + platform_fee), 0) AS total_gross_volume
         FROM relay_settlements
         WHERE settled_at >= ?`,
      )
      .get(since) as {
      settlement_count: number;
      total_settled: number;
      total_platform_fees: number;
      total_gross_volume: number;
    };

    const daily = moteDb.db
      .prepare(
        `SELECT
           (settled_at / 86400000) AS day_epoch,
           COUNT(*) AS count,
           COALESCE(SUM(platform_fee), 0) AS fees,
           COALESCE(SUM(amount_settled + platform_fee), 0) AS volume
         FROM relay_settlements
         WHERE settled_at >= ?
         GROUP BY day_epoch
         ORDER BY day_epoch`,
      )
      .all(since) as Array<{ day_epoch: number; count: number; fees: number; volume: number }>;

    return c.json({
      period_days: days,
      ...totals,
      daily: daily.map((d) => ({
        date: new Date(d.day_epoch * 86_400_000).toISOString().slice(0, 10),
        settlement_count: d.count,
        platform_fees: d.fees,
        gross_volume: d.volume,
      })),
    });
  });

  app.get("/api/v1/market/candidates", (c) => {
    const capability = c.req.query("capability");
    const maxBudgetStr = c.req.query("max_budget");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10) || 20, 1), 100);
    const maxBudget = maxBudgetStr ? parseFloat(maxBudgetStr) : undefined;

    const { profiles, requirements } = taskRouter.buildCandidateProfiles(
      capability ?? undefined,
      maxBudget,
      limit,
    );

    const explorationStr = c.req.query("exploration_drive");
    const explorationWeight =
      explorationStr != null ? Math.max(0, Math.min(1, parseFloat(explorationStr))) : undefined;
    const peerEdges = taskRouter.fetchPeerEdges();
    const ranked = graphRankCandidates(asMotebitId("relay"), profiles, requirements, {
      explorationWeight,
      peerEdges,
    });

    return c.json({
      candidates: ranked.map((score) => {
        const profile = profiles.find((p) => p.motebit_id === score.motebit_id);
        return {
          motebit_id: score.motebit_id,
          composite: score.composite,
          sub_scores: score.sub_scores,
          selected: score.selected,
          capabilities: profile?.listing?.capabilities ?? [],
          pricing: profile?.listing?.pricing ?? [],
          sla: profile?.listing?.sla ?? null,
          description: profile?.listing?.description ?? "",
          is_online: profile?.is_online ?? false,
          latency_stats: profile?.latency_stats ?? null,
        };
      }),
    });
  });
}
