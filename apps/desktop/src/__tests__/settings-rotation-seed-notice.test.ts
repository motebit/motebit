/**
 * @vitest-environment jsdom
 *
 * A committed key rotation changes the recovery seed (the seed IS the key).
 * Mounts the REAL index.html and the REAL `initSettings`, drives the Rotate
 * Key dialog, and reads what the owner is told: the seed notice, once, only
 * when the rotation committed — never on a refused one (the old key stays).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROTATION_SEED_BACKUP_NOTICE } from "@motebit/surface-kit";

const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }));
vi.mock("../ui/chat", () => ({ addMessage }));
vi.mock("../ui/mcp-connections", () => ({ getMcpServersConfig: vi.fn(() => []) }));
vi.mock("../ui/machines-section", () => ({ mountMachines: vi.fn() }));
vi.mock("../config-update", () => ({ updateConfig: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, "../../index.html"), "utf8");
const body = /<body[^>]*>([\s\S]*)<\/body>/i
  .exec(html)![1]!
  .replace(/<script[\s\S]*?<\/script>/gi, "");
type Settings = typeof import("../ui/settings");
let mod: Settings;

beforeAll(async () => {
  document.body.innerHTML = body;
  mod = await import("../ui/settings");
});

beforeEach(() => {
  // Fresh elements per test: each mount wires its own listeners.
  document.body.innerHTML = body;
  addMessage.mockClear();
});

function stub(overrides: Record<string, unknown> = {}): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (typeof key === "string" && key in overrides) return overrides[key];
        if (key === "then") return undefined;
        if (key === "isOperatorMode") return false;
        if (key === "currentModel") return null;
        return vi.fn(() => undefined);
      },
    },
  );
}

function mount(rotateKey: () => Promise<unknown>) {
  const config = { provider: "anthropic", isTauri: true, invoke: vi.fn(async () => null) };
  const ctx = {
    // The identity-tab refresh after the commit reads more of the app than
    // this stub provides and throws; the notice is said BEFORE it, so the
    // stub also proves a refresh failure cannot swallow it.
    app: stub({ rotateKey }),
    getConfig: () => config,
    setConfig: vi.fn(),
  };
  const deps = { colorPicker: stub(), voice: stub(), pairing: stub() };
  mod.initSettings(ctx as never, deps as never);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settle = () => new Promise((r) => setTimeout(r, 0));

async function rotateViaDialog(): Promise<void> {
  $<HTMLButtonElement>("settings-rotate-key").click();
  $<HTMLButtonElement>("rotate-key-confirm").click();
  await settle();
  await settle();
}

describe("desktop Settings — Rotate Key tells the owner the seed changed", () => {
  it("a committed rotation says the seed notice, once", async () => {
    mount(async () => ({ oldKeyFingerprint: "aa", newKeyFingerprint: "bb", rotationCount: 1 }));
    await rotateViaDialog();
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith("system", ROTATION_SEED_BACKUP_NOTICE);
  });

  it("a refused rotation (the old key stays) says nothing about the seed", async () => {
    mount(async () => {
      throw new Error("the relay refused the rotation");
    });
    await rotateViaDialog();
    expect($<HTMLDivElement>("rotate-key-error").textContent).toContain("refused");
    expect(addMessage).not.toHaveBeenCalled();
  });
});
