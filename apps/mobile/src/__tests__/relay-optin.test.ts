/**
 * The Settings → Identity relay opt-in (founder-approved 2026-10-11): a
 * phone-only user can connect to a relay without pairing. Pins the
 * controller half — URL validation/normalization, enable = persist +
 * startSync, disable = stop + clear, a failed enable rolls back, and a
 * relaunch resumes only when a URL is saved.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_RELAY_URL,
  autoStartRelaySync,
  connectRelay,
  disconnectRelay,
  normalizeRelayUrl,
  parseRelayUrl,
  type RelayOptInPort,
} from "../relay-optin";

type FakePort = { -readonly [K in keyof RelayOptInPort]: RelayOptInPort[K] } & {
  saved: { url: string | null; running: boolean };
};

function fakePort(over: Partial<RelayOptInPort> = {}): FakePort {
  const saved = { url: null as string | null, running: false };
  const port = {
    saved,
    syncStatus: "offline" as RelayOptInPort["syncStatus"],
    getSyncUrl: vi.fn(async () => saved.url),
    setSyncUrl: vi.fn(async (url: string) => {
      saved.url = url;
    }),
    startSync: vi.fn(async (url?: string) => {
      saved.url = url ?? saved.url;
      saved.running = true;
      port.syncStatus = "idle";
    }),
    disconnectSync: vi.fn(async () => {
      saved.running = false;
      saved.url = null;
      port.syncStatus = "offline";
    }),
    ...over,
  };
  return port;
}

describe("relay URL parsing", () => {
  it("defaults to the public relay", () => {
    expect(DEFAULT_RELAY_URL).toBe("https://relay.motebit.com");
  });

  it("normalizes scheme, whitespace and trailing slashes", () => {
    expect(normalizeRelayUrl("  relay.example.com ")).toBe("https://relay.example.com");
    expect(parseRelayUrl("relay.example.com/")).toEqual({
      ok: true,
      url: "https://relay.example.com",
    });
    expect(parseRelayUrl("http://localhost:3000")).toEqual({
      ok: true,
      url: "http://localhost:3000",
    });
  });

  it("rejects empty and malformed input", () => {
    expect(parseRelayUrl("   ").ok).toBe(false);
    expect(parseRelayUrl("https://").ok).toBe(false);
    expect(parseRelayUrl("https://exa mple.com").ok).toBe(false);
  });
});

describe("connectRelay / disconnectRelay", () => {
  it("enable persists the normalized URL and starts sync with it", async () => {
    const port = fakePort();
    const result = await connectRelay(port, " relay.example.com/ ");
    expect(result).toEqual({ ok: true, url: "https://relay.example.com" });
    expect(port.setSyncUrl).toHaveBeenCalledWith("https://relay.example.com");
    expect(port.startSync).toHaveBeenCalledWith("https://relay.example.com");
    expect(port.saved).toEqual({ url: "https://relay.example.com", running: true });
  });

  it("an invalid URL touches nothing", async () => {
    const port = fakePort();
    const result = await connectRelay(port, "https://");
    expect(result.ok).toBe(false);
    expect(port.setSyncUrl).not.toHaveBeenCalled();
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("a relay that refuses the device rolls the opt-in back", async () => {
    const port = fakePort();
    port.startSync = vi.fn(async () => {
      port.syncStatus = "error";
    });
    const result = await connectRelay(port, DEFAULT_RELAY_URL);
    expect(result).toEqual({ ok: false, error: "Could not connect to the relay" });
    expect(port.disconnectSync).toHaveBeenCalledTimes(1);
    expect(port.saved.url).toBeNull();
  });

  it("a start that throws rolls the opt-in back and says why", async () => {
    const port = fakePort();
    port.startSync = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await connectRelay(port, DEFAULT_RELAY_URL);
    expect(result).toEqual({ ok: false, error: "Could not connect to the relay: offline" });
    expect(port.saved.url).toBeNull();
  });

  it("an enable superseded by a newer start never rolls that start back", async () => {
    // Pairing (or OFF) started a newer attempt while this enable was in
    // flight: the shared status belongs to that attempt, not to this enable.
    const port = fakePort();
    port.relayGeneration = 0;
    port.startSync = vi.fn(async () => {
      port.relayGeneration = (port.relayGeneration ?? 0) + 2; // ours, then the newer start
      port.syncStatus = "error"; // the newer attempt's registration is retrying
    });
    const result = await connectRelay(port, DEFAULT_RELAY_URL);
    expect(result).toEqual({ ok: false, error: "Relay connection was interrupted" });
    expect(port.disconnectSync).not.toHaveBeenCalled();
  });

  it("an enable that is still the live attempt rolls back on its own refusal", async () => {
    const port = fakePort();
    port.relayGeneration = 4;
    port.startSync = vi.fn(async () => {
      port.relayGeneration = 5;
      port.syncStatus = "error";
    });
    const result = await connectRelay(port, DEFAULT_RELAY_URL);
    expect(result).toEqual({ ok: false, error: "Could not connect to the relay" });
    expect(port.disconnectSync).toHaveBeenCalledTimes(1);
  });

  it("disable stops sync and clears the saved URL", async () => {
    const port = fakePort();
    await connectRelay(port, DEFAULT_RELAY_URL);
    await disconnectRelay(port);
    expect(port.disconnectSync).toHaveBeenCalledTimes(1);
    expect(port.saved).toEqual({ url: null, running: false });
  });
});

describe("autoStartRelaySync (launch)", () => {
  it("stays offline when no URL is saved", async () => {
    const port = fakePort();
    expect(await autoStartRelaySync(port)).toBeNull();
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("resumes sync with the saved URL after an opt-in", async () => {
    const port = fakePort();
    await connectRelay(port, DEFAULT_RELAY_URL);
    vi.mocked(port.startSync).mockClear();
    expect(await autoStartRelaySync(port)).toBe(DEFAULT_RELAY_URL);
    expect(port.startSync).toHaveBeenCalledWith(DEFAULT_RELAY_URL);
  });

  it("stays offline on the launch after an opt-out", async () => {
    const port = fakePort();
    await connectRelay(port, DEFAULT_RELAY_URL);
    await disconnectRelay(port);
    vi.mocked(port.startSync).mockClear();
    expect(await autoStartRelaySync(port)).toBeNull();
    expect(port.startSync).not.toHaveBeenCalled();
  });
});
