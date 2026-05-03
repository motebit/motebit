import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScribeTranscriber } from "../scribe-transcriber.js";
import type { FileTranscriber } from "../stt.js";

// ---------------------------------------------------------------------------
// Mock fetch + FormData
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  fields: Map<string, string>;
  fileBlob: Blob | null;
}

let captured: CapturedRequest | null = null;

class MockFormData {
  private readonly fields = new Map<string, string>();
  private fileBlob: Blob | null = null;

  append(name: string, value: Blob | string): void {
    if (value instanceof Blob) {
      this.fileBlob = value;
    } else {
      this.fields.set(name, value);
    }
  }

  get _fields(): Map<string, string> {
    return this.fields;
  }
  get _fileBlob(): Blob | null {
    return this.fileBlob;
  }
}

function installMocks(options?: { status?: number; json?: unknown; text?: string }): void {
  captured = null;
  const status = options?.status ?? 200;
  const json = options?.json ?? { text: "  hello world  " };
  const text = options?.text ?? "";

  Object.defineProperty(globalThis, "FormData", {
    value: MockFormData,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "fetch", {
    value: vi.fn(async (url: string, init: RequestInit) => {
      const fd = init.body as unknown as MockFormData;
      captured = {
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        fields: fd._fields,
        fileBlob: fd._fileBlob,
      };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => text,
      };
    }),
    writable: true,
    configurable: true,
  });
}

describe("ScribeTranscriber", () => {
  beforeEach(() => installMocks());
  afterEach(() => {
    captured = null;
  });

  it("implements FileTranscriber interface", () => {
    const t: FileTranscriber = new ScribeTranscriber({ apiKey: "xi-test" });
    expect(typeof t.transcribe).toBe("function");
  });

  it("POSTs to /v1/speech-to-text with xi-api-key header", async () => {
    const t = new ScribeTranscriber({ apiKey: "xi-test-key" });
    const blob = new Blob(["audio"]);
    await t.transcribe(blob);

    expect(captured?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers["xi-api-key"]).toBe("xi-test-key");
    expect(captured?.fields.get("model_id")).toBe("scribe_v2");
    expect(captured?.fileBlob).toBe(blob);
  });

  it("uses configured model override", async () => {
    const t = new ScribeTranscriber({ apiKey: "xi", modelId: "scribe_v1" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.get("model_id")).toBe("scribe_v1");
  });

  it("attaches language_code when configured", async () => {
    const t = new ScribeTranscriber({ apiKey: "xi", languageCode: "en" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.get("language_code")).toBe("en");
  });

  it("omits language_code when not configured", async () => {
    const t = new ScribeTranscriber({ apiKey: "xi" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.has("language_code")).toBe(false);
  });

  it("uses custom baseUrl", async () => {
    const t = new ScribeTranscriber({ apiKey: "xi", baseUrl: "https://proxy.example.com" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.url).toBe("https://proxy.example.com/v1/speech-to-text");
  });

  it("returns trimmed text from JSON response", async () => {
    installMocks({ json: { text: "  spaced transcript  " } });
    const t = new ScribeTranscriber({ apiKey: "xi" });
    expect(await t.transcribe(new Blob(["x"]))).toBe("spaced transcript");
  });

  it("returns empty string when text field absent", async () => {
    installMocks({ json: { language_code: "en" } });
    const t = new ScribeTranscriber({ apiKey: "xi" });
    expect(await t.transcribe(new Blob(["x"]))).toBe("");
  });

  it("throws on non-2xx response with body", async () => {
    installMocks({ status: 429, text: "Rate limited" });
    const t = new ScribeTranscriber({ apiKey: "xi" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow("Scribe error: 429 — Rate limited");
  });

  it("throws on non-2xx response with empty body", async () => {
    installMocks({ status: 500, text: "" });
    const t = new ScribeTranscriber({ apiKey: "xi" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow("Scribe error: 500");
  });

  it("survives response.text() throwing during error path", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => ({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error("body read failed");
        },
      })),
      writable: true,
      configurable: true,
    });
    const t = new ScribeTranscriber({ apiKey: "xi" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow("Scribe error: 502");
  });
});
