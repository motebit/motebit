import { describe, it, expect } from "vitest";
import {
  requestContext,
  getRequestContext,
  getCorrelationId,
  enrichRequestContext,
} from "../request-context.js";
import type { RequestContext } from "../request-context.js";

function makeCtx(overrides?: Partial<RequestContext>): RequestContext {
  return {
    correlationId: "test-corr-id",
    startedAt: Date.now(),
    method: "GET",
    path: "/test",
    ...overrides,
  };
}

describe("request-context", () => {
  it("returns undefined outside a request", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("generates a fresh correlation ID outside a request", () => {
    const id = getCorrelationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // Should be different each time (UUID)
    expect(getCorrelationId()).not.toBe(id);
  });

  it("provides context inside requestContext.run()", () => {
    const ctx = makeCtx({ correlationId: "abc-123" });
    requestContext.run(ctx, () => {
      expect(getRequestContext()).toBe(ctx);
      expect(getCorrelationId()).toBe("abc-123");
    });
  });

  it("propagates through async boundaries", async () => {
    const ctx = makeCtx({ correlationId: "async-test" });
    await requestContext.run(ctx, async () => {
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getCorrelationId()).toBe("async-test");

      // Nested async
      const result = await Promise.resolve().then(() => getCorrelationId());
      expect(result).toBe("async-test");
    });
  });

  it("isolates concurrent requests", async () => {
    const results: string[] = [];

    const req1 = requestContext.run(makeCtx({ correlationId: "req-1" }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      results.push(getCorrelationId());
    });

    const req2 = requestContext.run(makeCtx({ correlationId: "req-2" }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      results.push(getCorrelationId());
    });

    await Promise.all([req1, req2]);
    // req2 finishes first, but each sees its own context
    expect(results).toContain("req-1");
    expect(results).toContain("req-2");
  });

  it("enrichRequestContext adds motebitId", () => {
    const ctx = makeCtx();
    requestContext.run(ctx, () => {
      expect(ctx.motebitId).toBeUndefined();
      enrichRequestContext({ motebitId: "mote-abc" });
      expect(getRequestContext()?.motebitId).toBe("mote-abc");
    });
  });

  it("enrichRequestContext adds deviceId", () => {
    const ctx = makeCtx();
    requestContext.run(ctx, () => {
      enrichRequestContext({ deviceId: "dev-xyz" });
      expect(getRequestContext()?.deviceId).toBe("dev-xyz");
    });
  });

  it("enrichRequestContext is a no-op outside a request", () => {
    // Should not throw
    enrichRequestContext({ motebitId: "nope" });
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("logger integration with request-context", () => {
  it("createLogger includes correlationId from context", async () => {
    // Dynamic import to ensure logger picks up the context module
    const { createLogger, setLogLevel } = await import("../logger.js");
    setLogLevel("debug");

    const captured: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      captured.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const logger = createLogger({ service: "test" });

      // Outside context — no correlationId auto-injected
      logger.info("no-context");
      const outsideLine = JSON.parse(captured[captured.length - 1]!);
      expect(outsideLine.correlationId).toBeUndefined();

      // Inside context — correlationId auto-injected
      const ctx = makeCtx({ correlationId: "logger-ctx-test" });
      requestContext.run(ctx, () => {
        logger.info("with-context");
      });
      const insideLine = JSON.parse(captured[captured.length - 1]!);
      expect(insideLine.correlationId).toBe("logger-ctx-test");

      // Explicit correlationId in data overrides context
      requestContext.run(ctx, () => {
        logger.info("override", { correlationId: "explicit-id" });
      });
      const overrideLine = JSON.parse(captured[captured.length - 1]!);
      expect(overrideLine.correlationId).toBe("explicit-id");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
