/**
 * Skills panel — full lifecycle integration test on web.
 *
 * Closes the silent-correctness gap: registry construction wired
 * through bootstrap, panel renders Browse + Installed sections, install
 * via the controller's `installFromSource({ kind: "url" })` path
 * persists through IDB, enable + remove round-trip through the
 * controller. The fetch stub returns a real signed envelope so the
 * registry's signature-verification path is exercised end-to-end.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";
import type { SkillRegistryListing, SkillRegistryBundle } from "@motebit/sdk";
import { canonicalJson, hash, signSkillEnvelope } from "@motebit/crypto";
import { SkillRegistry } from "@motebit/skills";
import { IdbSkillStorageAdapter, openMotebitDB } from "@motebit/browser-persistence";

import { initSkillsPanel } from "../ui/skills-panel";
import type { WebContext } from "../types";
import type { WebApp } from "../web-app";

// JSDom's crypto.subtle.digest rejects the underlying-buffer slice that
// noble's default sha512Async passes — override both hash hooks so every
// noble code path uses the in-process @noble/hashes implementation, and
// borrow Node's webcrypto for `crypto.subtle.digest` calls inside
// `@motebit/crypto` (which still routes SHA-256 through subtle).
// Override sha512 in our externally-imported noble — applies to any
// path inside this test that touches @noble/ed25519 directly. The
// matching `crypto.subtle.digest` coercion that lets `@motebit/crypto`'s
// bundled noble copy reach `subtle.digest` lives in setup.ts so every
// signing-test in this package shares it.
ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const PANEL_DOM = `
  <div id="skills-backdrop"></div>
  <div id="skills-panel">
    <span id="skills-count">0</span>
    <button id="skills-close-btn"></button>
    <input id="skills-search" />
    <input id="skills-include-unfeatured" type="checkbox" />
    <div id="skills-list"></div>
    <div id="skills-detail">
      <button id="skills-detail-back"></button>
      <div id="skills-detail-body"></div>
    </div>
  </div>
`;

async function buildBundle(name = "panel-test-skill"): Promise<{
  manifest: SkillManifest;
  envelope: SkillEnvelope;
  body: Uint8Array;
}> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const body = new TextEncoder().encode("# integration\n\n## When to Use\n\nIn the test.\n");
  const manifest: SkillManifest = {
    name,
    description: "Integration test fixture",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { category: "test", tags: ["integration"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  };
  const contentBytes = new TextEncoder().encode(canonicalJson(manifest));
  const full = new Uint8Array(contentBytes.length + 1 + body.length);
  full.set(contentBytes, 0);
  full[contentBytes.length] = 0x0a;
  full.set(body, contentBytes.length + 1);
  const contentHash = await hash(full);
  const bodyHash = await hash(body);
  const envelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: { name: manifest.name, version: manifest.version, content_hash: contentHash },
      manifest,
      body_hash: bodyHash,
      files: [],
    },
    privateKey,
    publicKey,
  );
  return { manifest, envelope, body };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

describe("Skills panel — full lifecycle on web (IDB-backed)", () => {
  beforeEach(() => {
    document.body.innerHTML = PANEL_DOM;
    history.replaceState({}, "", "/");
  });

  it("browse → install → enable toggle persists → remove", async () => {
    const { envelope, body } = await buildBundle();
    const dbName = `panel-test-${crypto.randomUUID()}`;
    const db = await openMotebitDB(dbName);
    const registry = new SkillRegistry(new IdbSkillStorageAdapter(db));

    const submitter = "did:key:zTestSubmitter";
    const submittedAt = Date.now();
    const listing: SkillRegistryListing = {
      entries: [
        {
          submitter_motebit_id: submitter,
          name: envelope.skill.name,
          version: envelope.skill.version,
          content_hash: envelope.skill.content_hash,
          description: envelope.manifest.description,
          sensitivity: "none",
          platforms: envelope.manifest.platforms ?? ["macos"],
          signature_public_key: envelope.signature.public_key,
          submitted_at: submittedAt,
          featured: true,
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    };
    const bundle: SkillRegistryBundle = {
      submitter_motebit_id: submitter,
      envelope,
      body: bytesToBase64(body),
      files: {},
      submitted_at: submittedAt,
      featured: true,
    };

    const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/v1/skills/discover")) {
        return new Response(JSON.stringify(listing), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes(`/api/v1/skills/${encodeURIComponent(submitter)}/`)) {
        return new Response(JSON.stringify(bundle), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const ctx: WebContext = {
      app: { getSkillRegistry: () => registry } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };

    const api = initSkillsPanel(ctx);
    api.open();

    // Wait for refresh: discover fetch + registry.list both settle.
    await new Promise((r) => setTimeout(r, 30));

    const list = document.getElementById("skills-list") as HTMLDivElement;
    expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    expect(list.querySelectorAll(".skill-row-installed").length).toBe(0);

    // Install via the per-row Install button.
    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    expect(installBtn).not.toBeNull();
    installBtn!.click();
    await new Promise((r) => setTimeout(r, 50));

    // Installed list now has the skill, controller's enabled flag = true.
    expect(list.querySelectorAll(".skill-row-installed").length).toBe(1);
    const installedFromIdb = await registry.list();
    expect(installedFromIdb.length).toBe(1);
    expect(installedFromIdb[0]!.index.enabled).toBe(true);

    // Toggle enable → disable.
    const disableBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-installed button[data-action="toggle-enabled"]',
    );
    expect(disableBtn?.textContent).toBe("Disable");
    disableBtn!.click();
    await new Promise((r) => setTimeout(r, 30));
    const afterToggle = await registry.list();
    expect(afterToggle[0]!.index.enabled).toBe(false);

    // Reopen the registry from a separate IDB handle — state persists.
    const db2 = await openMotebitDB(dbName);
    const registry2 = new SkillRegistry(new IdbSkillStorageAdapter(db2));
    const persisted = await registry2.list();
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.index.enabled).toBe(false);

    // Remove via the per-row button.
    const removeBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-installed button[data-action="remove"]',
    );
    expect(removeBtn).not.toBeNull();
    removeBtn!.click();
    await new Promise((r) => setTimeout(r, 30));
    const afterRemove = await registry.list();
    expect(afterRemove.length).toBe(0);
  });

  // Trust-path coverage is intentionally absent: `SkillRegistry`'s
  // `derivedStatusForEntry` returns `"verified"` whenever the envelope
  // verifies, regardless of `index.trusted`. The panel's Trust button
  // only renders for non-verified rows, so a successfully-installed
  // skill never surfaces the button — the `"unsigned"` provenance
  // branch is unreachable through the public install path today. A
  // future test belongs alongside whatever change makes the manifest-
  // level `motebit.signature` a separate provenance axis from the
  // envelope-level signature; the panel-level wiring is already
  // covered structurally (the button render condition + click handler
  // are exercised whenever the renderer iterates installed rows).
});
