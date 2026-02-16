import { Hono } from "hono";

const app = new Hono();

// === Types ===

interface InferenceRequest {
  provider: "openai" | "anthropic" | "local";
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface InferenceResponse {
  request_id: string;
  text: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_cost_usd: number;
  };
}

// === Request Queue ===

interface QueuedRequest {
  id: string;
  request: InferenceRequest;
  created_at: number;
  status: "pending" | "processing" | "completed" | "failed";
}

const requestQueue: QueuedRequest[] = [];

// === Routes ===

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/api/v1/inference", async (c) => {
  const body = await c.req.json<InferenceRequest>();
  const requestId = crypto.randomUUID();

  // Queue the request
  requestQueue.push({
    id: requestId,
    request: body,
    created_at: Date.now(),
    status: "pending",
  });

  // In production: proxy to actual LLM provider
  // For now: return structured placeholder
  const response: InferenceResponse = {
    request_id: requestId,
    text: `[${body.provider}/${body.model}] Inference response placeholder`,
    model: body.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_cost_usd: 0,
    },
  };

  return c.json(response);
});

app.get("/api/v1/inference/:requestId", (c) => {
  const requestId = c.req.param("requestId");
  const request = requestQueue.find((r) => r.id === requestId);
  if (request === undefined) {
    return c.json({ error: "Request not found" }, 404);
  }
  return c.json(request);
});

// Cost tracking
app.get("/api/v1/costs", (c) => {
  return c.json({
    total_requests: requestQueue.length,
    total_cost_usd: 0,
    by_provider: {},
  });
});

export default app;
export { app };
