/**
 * Trust Graph routes — trust queries, routing visualization, path finding.
 *
 * Pure reads: agent trust records, trust closure, trusted paths,
 * routing graph, routing explanation with scoring detail.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { asMotebitId } from "@motebit/sdk";
import {
  computeTrustClosure,
  findTrustedRoute,
  buildRoutingGraph,
  explainedRankCandidates,
} from "@motebit/market";
import type { TaskRouter } from "./task-routing.js";

export interface TrustGraphDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  taskRouter: TaskRouter;
}

export function registerTrustGraphRoutes(deps: TrustGraphDeps): void {
  const { app, moteDb, taskRouter } = deps;

  // --- Agent Trust: trust records for known agents ---
  /** @internal */
  app.get("/api/v1/agent-trust/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const records = await moteDb.agentTrustStore.listAgentTrust(motebitId);
    return c.json({ motebit_id: motebitId, records });
  });

  // --- Graph Query: trust closure for an agent ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/trust-closure", (c) => {
    const motebitId = c.req.param("motebitId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const closure = computeTrustClosure(asMotebitId(motebitId), profiles);
    const closureArray = Array.from(closure.entries())
      .map(([agent_id, trust]) => ({ agent_id, trust }))
      .sort((a, b) => b.trust - a.trust);
    return c.json({ motebit_id: motebitId, closure: closureArray });
  });

  // --- Graph Query: find trusted path between two agents ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/path-to/:targetId", (c) => {
    const motebitId = c.req.param("motebitId");
    const targetId = c.req.param("targetId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const route = findTrustedRoute(asMotebitId(motebitId), asMotebitId(targetId), profiles);
    if (!route) {
      throw new HTTPException(404, { message: "No trusted path found" });
    }
    return c.json({ source: motebitId, target: targetId, trust: route.trust, path: route.path });
  });

  // --- Graph Query: full routing graph for an agent ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/graph", (c) => {
    const motebitId = c.req.param("motebitId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const graph = buildRoutingGraph(asMotebitId(motebitId), profiles);
    const nodes = [...graph.nodes()];
    const edges = graph.edges().map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
    return c.json({
      motebit_id: motebitId,
      nodes,
      edges,
      node_count: nodes.length,
      edge_count: edges.length,
    });
  });

  // --- Graph Query: routing explanation with full scoring detail ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/routing-explanation", (c) => {
    const motebitId = c.req.param("motebitId");
    const capability = c.req.query("capability");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10) || 10, 1), 100);
    const { profiles, requirements } = taskRouter.buildCandidateProfiles(
      capability ?? undefined,
      undefined,
      limit,
      motebitId,
    );
    const peerEdges = taskRouter.fetchPeerEdges();
    const guardianRow = moteDb.db
      .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { guardian_public_key: string | null } | undefined;
    const ranked = explainedRankCandidates(asMotebitId(motebitId), profiles, requirements, {
      peerEdges,
      callerGuardianPublicKey: guardianRow?.guardian_public_key ?? undefined,
    });
    return c.json({ motebit_id: motebitId, scores: ranked });
  });
}
