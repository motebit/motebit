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

// Assertion-driven polling. The install/toggle/remove paths are fire-and-
// forget click handlers — the test has no direct handle on the in-flight
// promise — so we poll the post-condition until it holds. Locally these
// settle in <10ms; the GitHub Linux runner has hit 50ms+, so a fixed
// delay flakes. Polling caps at 2000ms which is well above any real run
// (the whole skills-panel suite ran 921ms locally, 2896ms on CI) and
// fails the assertion verbatim if the condition never becomes true.
async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (err: unknown) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";
import type { SkillRegistryListing, SkillRegistryBundle } from "@motebit/sdk";
import { canonicalJson, hash, signSkillEnvelope } from "@motebit/crypto";
import { SkillRegistry } from "@motebit/skills";
import {
  IdbSkillAuditSink,
  IdbSkillStorageAdapter,
  openMotebitDB,
} from "@motebit/browser-persistence";

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
  <div id="skills-consent-backdrop"></div>
  <div id="skills-consent-modal" role="dialog">
    <div id="skills-consent-title"></div>
    <div id="skills-consent-body"></div>
    <button id="skills-consent-cancel">Cancel</button>
    <button id="skills-consent-approve">Install</button>
  </div>
`;

async function buildBundle(
  name = "panel-test-skill",
  sensitivity: SkillManifest["motebit"]["sensitivity"] = "none",
): Promise<{
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
      sensitivity,
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
      app: { getSkillRegistry: () => registry, getSkillAuditSink: () => null } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };

    const api = initSkillsPanel(ctx);
    api.open();

    // Wait for refresh: discover fetch + registry.list both settle.
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });
    expect(list.querySelectorAll(".skill-row-installed").length).toBe(0);

    // Install via the per-row Install button.
    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    expect(installBtn).not.toBeNull();
    installBtn!.click();

    // Installed list now has the skill, controller's enabled flag = true.
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-installed").length).toBe(1);
    });
    const installedFromIdb = await registry.list();
    expect(installedFromIdb.length).toBe(1);
    expect(installedFromIdb[0]!.index.enabled).toBe(true);

    // Toggle enable → disable.
    const disableBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-installed button[data-action="toggle-enabled"]',
    );
    expect(disableBtn?.textContent).toBe("Disable");
    disableBtn!.click();
    await waitFor(async () => {
      const after = await registry.list();
      expect(after[0]!.index.enabled).toBe(false);
    });

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
    await waitFor(async () => {
      const afterRemove = await registry.list();
      expect(afterRemove.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Trust path — manifest.motebit.signature is absent → "unsigned" → operator
  // promotes via the panel's Trust button → "trusted_unsigned". Reachable
  // now that `deriveProvenance` honors the manifest-vs-envelope signature
  // distinction (previously this path collapsed to "verified" regardless
  // of authorial provenance — see packages/skills/src/registry.ts).
  // -------------------------------------------------------------------------

  it("unsigned skill renders Trust button → click promotes to trusted_unsigned", async () => {
    // buildBundle produces a manifest WITHOUT motebit.signature (the
    // envelope itself is signed for distribution integrity per spec
    // §5; the manifest's authorial signature is what's absent). Post-
    // fix, this installs as "unsigned" instead of collapsing to
    // "verified" — the Trust button renders for non-verified rows.
    const { envelope, body } = await buildBundle("trust-path-skill", "none");
    const dbName = `panel-trust-${crypto.randomUUID()}`;
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as unknown as typeof fetch;

    const ctx: WebContext = {
      app: {
        getSkillRegistry: () => registry,
        getSkillAuditSink: () => null,
      } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };
    const api = initSkillsPanel(ctx);
    api.open();
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });

    // Install via the per-row Install button (no consent prompt — none-tier).
    list
      .querySelector<HTMLButtonElement>('.skill-row-browse button[data-action="install"]')!
      .click();
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-installed").length).toBe(1);
    });

    // Pre-fix this would have collapsed to "verified" and the trust
    // button wouldn't render. Post-fix the unsigned manifest surfaces
    // as "unsigned" and the button is present.
    const installedFromIdb = await registry.list();
    expect(installedFromIdb[0]!.provenance_status).toBe("unsigned");
    const trustBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-installed button[data-action="toggle-trusted"]',
    );
    expect(trustBtn).not.toBeNull();
    expect(trustBtn?.textContent).toBe("Trust");

    // Click Trust → operator-attested promotion. Provenance flips to
    // trusted_unsigned (the [unverified] qualifier remains everywhere
    // the skill surfaces per spec §7.1). Poll on the rendered button
    // text so we wait for both the registry write and the controller's
    // subscribe-driven re-render — registry.list() resolving alone
    // races the renderAll() callback.
    trustBtn!.click();
    await waitFor(() => {
      const btn = list.querySelector<HTMLButtonElement>(
        '.skill-row-installed button[data-action="toggle-trusted"]',
      );
      expect(btn?.textContent).toBe("Untrust");
    });
    const afterTrust = await registry.list();
    expect(afterTrust[0]!.provenance_status).toBe("trusted_unsigned");
    expect(afterTrust[0]!.index.trusted).toBe(true);

    // Untrust button now renders in place of Trust.
    const untrustBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-installed button[data-action="toggle-trusted"]',
    );
    expect(untrustBtn?.textContent).toBe("Untrust");
    untrustBtn!.click();
    await waitFor(() => {
      const btn = list.querySelector<HTMLButtonElement>(
        '.skill-row-installed button[data-action="toggle-trusted"]',
      );
      expect(btn?.textContent).toBe("Trust");
    });
    const afterUntrust = await registry.list();
    expect(afterUntrust[0]!.provenance_status).toBe("unsigned");
    expect(afterUntrust[0]!.index.trusted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Consent gate — sensitive-tier install on weak-isolation surface (web).
  // The adapter calls `requestInstallConsent` after the bundle fetch but
  // before `registry.install`; the panel's HTML modal collects the user's
  // decision. Decline is the calm-software default (backdrop click, ESC,
  // Cancel) — no toast, no install. Approve proceeds to install verbatim.
  // -------------------------------------------------------------------------

  it("medical-tier install opens consent modal and proceeds on approve", async () => {
    const { envelope, body } = await buildBundle("consent-medical-skill", "medical");
    const dbName = `panel-consent-${crypto.randomUUID()}`;
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
          sensitivity: "medical",
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as unknown as typeof fetch;

    const ctx: WebContext = {
      app: { getSkillRegistry: () => registry, getSkillAuditSink: () => null } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };
    const api = initSkillsPanel(ctx);
    api.open();
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });

    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    expect(installBtn).not.toBeNull();
    installBtn!.click();

    // The adapter awaits requestInstallConsent before registry.install
    // — the modal is now open and the install is pending.
    const modal = document.getElementById("skills-consent-modal");
    await waitFor(() => {
      expect(modal?.classList.contains("open")).toBe(true);
    });
    const title = document.getElementById("skills-consent-title");
    expect(title?.textContent).toContain("consent-medical-skill");
    const body_ = document.getElementById("skills-consent-body");
    expect(body_?.innerHTML).toContain("medical");

    // Approve → modal closes, registry.install proceeds, IDB has the skill.
    const approveBtn = document.getElementById("skills-consent-approve") as HTMLButtonElement;
    approveBtn.click();
    await waitFor(async () => {
      expect(modal?.classList.contains("open")).toBe(false);
      const installed = await registry.list();
      expect(installed.length).toBe(1);
      expect(installed[0]!.manifest.motebit.sensitivity).toBe("medical");
    });
  });

  it("medical-tier install cancels silently on decline", async () => {
    const { envelope, body } = await buildBundle("consent-decline-skill", "financial");
    const dbName = `panel-decline-${crypto.randomUUID()}`;
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
          sensitivity: "financial",
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as unknown as typeof fetch;

    const showToast = vi.fn();
    const ctx: WebContext = {
      app: { getSkillRegistry: () => registry, getSkillAuditSink: () => null } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast,
      bootstrapProxy: () => Promise.resolve(false),
    };
    const api = initSkillsPanel(ctx);
    api.open();
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });

    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    installBtn!.click();

    const modal = document.getElementById("skills-consent-modal");
    await waitFor(() => {
      expect(modal?.classList.contains("open")).toBe(true);
    });

    const cancelBtn = document.getElementById("skills-consent-cancel") as HTMLButtonElement;
    cancelBtn.click();
    await waitFor(() => {
      expect(modal?.classList.contains("open")).toBe(false);
    });
    // Decline is silent — no toast (calm-software rule, modal close is the feedback).
    const toastForDecline = showToast.mock.calls.find((call: unknown[]) => {
      const first = call[0];
      return typeof first === "string" && first.toLowerCase().includes("declin");
    });
    expect(toastForDecline).toBeUndefined();
    // No install happened.
    const installed = await registry.list();
    expect(installed.length).toBe(0);
  });

  it("personal-tier install skips consent prompt entirely", async () => {
    // Sensitivity below the consent threshold flows straight into install
    // — important counter-test so the gate doesn't false-trigger on
    // every install and slow the happy path.
    const { envelope, body } = await buildBundle("consent-skip-skill", "personal");
    const dbName = `panel-skip-${crypto.randomUUID()}`;
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
          sensitivity: "personal",
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as unknown as typeof fetch;

    const ctx: WebContext = {
      app: { getSkillRegistry: () => registry, getSkillAuditSink: () => null } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };
    const api = initSkillsPanel(ctx);
    api.open();
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });

    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    installBtn!.click();
    // Personal-tier flows straight into install — wait for the row to
    // appear, then verify the modal never opened.
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-installed").length).toBe(1);
    });

    const modal = document.getElementById("skills-consent-modal");
    expect(modal?.classList.contains("open")).toBe(false);
    const installed = await registry.list();
    expect(installed.length).toBe(1);
    expect(installed[0]!.manifest.motebit.sensitivity).toBe("personal");
  });

  // -------------------------------------------------------------------------
  // Durable consent audit — `skill_consent_granted` event lands in the
  // IDB audit sink after a sensitive-tier install completes. Closes the
  // gap shipped by the consent-gate arc: the prompt fired but no
  // surface persisted the approval. Now web does.
  // -------------------------------------------------------------------------

  it("medical-tier install persists skill_consent_granted to the IDB audit sink", async () => {
    const { envelope, body } = await buildBundle("audit-medical-skill", "medical");
    const dbName = `panel-audit-${crypto.randomUUID()}`;
    const db = await openMotebitDB(dbName);
    const auditSink = new IdbSkillAuditSink(db);
    const registry = new SkillRegistry(new IdbSkillStorageAdapter(db), {
      audit: auditSink.record,
    });

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
          sensitivity: "medical",
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as unknown as typeof fetch;

    const ctx: WebContext = {
      app: {
        getSkillRegistry: () => registry,
        getSkillAuditSink: () => auditSink,
      } as unknown as WebApp,
      getConfig: () => null,
      setConfig: () => undefined,
      addMessage: () => undefined,
      showToast: () => undefined,
      bootstrapProxy: () => Promise.resolve(false),
    };
    const api = initSkillsPanel(ctx);
    api.open();
    const list = document.getElementById("skills-list") as HTMLDivElement;
    await waitFor(() => {
      expect(list.querySelectorAll(".skill-row-browse").length).toBe(1);
    });

    // Click Install on the browse row → consent modal opens → approve.
    const installBtn = list.querySelector<HTMLButtonElement>(
      '.skill-row-browse button[data-action="install"]',
    );
    installBtn!.click();
    const modal = document.getElementById("skills-consent-modal");
    await waitFor(() => {
      expect(modal?.classList.contains("open")).toBe(true);
    });
    const approveBtn = document.getElementById("skills-consent-approve") as HTMLButtonElement;
    approveBtn.click();
    await waitFor(async () => {
      const installed = await registry.list();
      expect(installed.length).toBe(1);
    });

    // Audit sink got the consent event with the right tags.
    const auditEvents = auditSink.getAll();
    const consentEvents = auditEvents.filter((e) => e.type === "skill_consent_granted");
    expect(consentEvents).toHaveLength(1);
    const event = consentEvents[0]!;
    expect(event).toMatchObject({
      type: "skill_consent_granted",
      skill_name: "audit-medical-skill",
      sensitivity: "medical",
      surface: "web",
    });
    expect(typeof event.at).toBe("string");

    // Verify durability — open a fresh sink against the same DB and
    // call preload(). The event must be there.
    const db2 = await openMotebitDB(dbName);
    const sink2 = new IdbSkillAuditSink(db2);
    await sink2.preload();
    const persisted = sink2.getAll().filter((e) => e.type === "skill_consent_granted");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.skill_name).toBe("audit-medical-skill");
  });
});
