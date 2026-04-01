export const runtime = "edge";

const ALLOWED_ORIGINS = new Set([
  "https://motebit.com",
  "https://www.motebit.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Max-Age": "86400",
  };
}

export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

interface ModelEntry {
  id: string;
  name: string;
}

export async function GET(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = corsHeaders(origin);
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  const apiKey = request.headers.get("x-api-key");

  if (!provider || !apiKey) {
    return new Response(JSON.stringify({ error: "provider and x-api-key required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    let models: ModelEntry[];

    switch (provider) {
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: `Anthropic: ${res.status}` }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        const data = (await res.json()) as {
          data?: Array<{ id: string; display_name?: string }>;
        };
        models = (data.data ?? []).map((m) => ({
          id: m.id,
          name: m.display_name ?? m.id,
        }));
        break;
      }

      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: `OpenAI: ${res.status}` }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        const data = (await res.json()) as {
          data?: Array<{ id: string; owned_by?: string }>;
        };
        models = (data.data ?? []).map((m) => ({
          id: m.id,
          name: m.id,
        }));
        break;
      }

      case "google": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) {
          return new Response(JSON.stringify({ error: `Google: ${res.status}` }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        const data = (await res.json()) as {
          models?: Array<{ name?: string; displayName?: string }>;
        };
        models = (data.models ?? []).map((m) => ({
          id: (m.name ?? "").replace("models/", ""),
          name: m.displayName ?? m.name ?? "",
        }));
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ ok: true, models }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}
