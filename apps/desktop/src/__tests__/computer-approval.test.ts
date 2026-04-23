/**
 * Tests for the desktop computer-use approval flow.
 *
 * Exercised paths:
 *   - no renderHost supplied → fail-closed (returns false without
 *     prompting).
 *   - Allow button click resolves true, card gains "Allowed" verdict,
 *     buttons disabled.
 *   - Deny button click resolves false, card gains "Denied" verdict.
 *   - The classifier's reason text reaches the card when present
 *     (sensitive `type` action).
 *   - Falls back to the kind-summary when classifier returns no reason
 *     (click / cursor_position routed through approval).
 *   - Double-click on Allow (race) is idempotent — the promise only
 *     resolves once.
 */
import { describe, expect, it, vi } from "vitest";

import type { ComputerAction } from "@motebit/sdk";

import {
  createComputerApprovalFlow,
  type ApprovalRenderHost,
  type CreateComputerApprovalFlowOptions,
} from "../computer-approval";

interface FakeElement {
  tag: string;
  className: string;
  textContent: string;
  disabled?: boolean;
  children: FakeElement[];
  listeners: Record<string, Array<() => void>>;
  appendChild: (child: FakeElement) => FakeElement;
  addEventListener: (type: string, handler: () => void) => void;
  click: () => void;
}

function makeFakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    className: "",
    textContent: "",
    children: [],
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    click() {
      for (const h of this.listeners.click ?? []) h();
    },
  };
  return el;
}

function makeDoc(): CreateComputerApprovalFlowOptions["doc"] {
  return {
    createElement(tag: string) {
      return makeFakeElement(tag) as unknown as ReturnType<
        NonNullable<CreateComputerApprovalFlowOptions["doc"]>["createElement"]
      >;
    },
  };
}

function makeHost(): ApprovalRenderHost & { children: FakeElement[] } {
  const children: FakeElement[] = [];
  return {
    children,
    appendChild(child: unknown) {
      children.push(child as FakeElement);
      return child;
    },
    scrollTop: 0,
    scrollHeight: 0,
  };
}

function findButton(card: FakeElement, label: string): FakeElement {
  for (const child of card.children) {
    if (child.className === "approval-buttons") {
      for (const btn of child.children) {
        if (btn.textContent === label) return btn;
      }
    }
  }
  throw new Error(`Button "${label}" not found in card`);
}

function findVerdict(card: FakeElement): string | null {
  for (const child of card.children) {
    if (child.className === "approval-verdict") return child.textContent;
  }
  return null;
}

describe("createComputerApprovalFlow — fail-closed", () => {
  it("returns false when renderHost is missing", async () => {
    const flow = createComputerApprovalFlow({ doc: makeDoc() });
    const result = await flow({ kind: "screenshot" });
    expect(result).toBe(false);
  });

  it("returns false when doc is missing (no DOM available)", async () => {
    const host = makeHost();
    // Simulate a non-browser environment by passing no doc + no globalThis.document.
    const flow = createComputerApprovalFlow({ renderHost: host });
    // In the test environment document is undefined (node), so this should
    // fail closed. If a shim is injected later we handle that explicitly.
    const result = await flow({ kind: "screenshot" });
    expect(result).toBe(false);
  });
});

describe("createComputerApprovalFlow — Allow path", () => {
  it("resolves true when Allow is clicked, stamps the card with 'Allowed'", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "screenshot" });

    // Card was mounted into the host.
    expect(host.children).toHaveLength(1);
    const card = host.children[0]!;
    expect(card.className).toBe("approval-card");

    // Click Allow.
    findButton(card, "Allow").click();

    await expect(pending).resolves.toBe(true);
    expect(findVerdict(card)).toBe("Allowed");
    expect(findButton(card, "Allow").disabled).toBe(true);
    expect(findButton(card, "Deny").disabled).toBe(true);
  });
});

describe("createComputerApprovalFlow — Deny path", () => {
  it("resolves false when Deny is clicked, stamps 'Denied'", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "cursor_position" });

    const card = host.children[0]!;
    findButton(card, "Deny").click();

    await expect(pending).resolves.toBe(false);
    expect(findVerdict(card)).toBe("Denied");
  });
});

describe("createComputerApprovalFlow — classifier reason surfacing", () => {
  it("surfaces the classifier rule + reason for sensitive `type` actions", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const action: ComputerAction = {
      kind: "type",
      text: `my secret key: sk-${"A".repeat(40)}`,
    };
    const pending = flow(action);

    const card = host.children[0]!;
    // The "why" line is a child of the card with class approval-args.
    const why = card.children.find((c) => c.className === "approval-args");
    expect(why).toBeDefined();
    // Classifier matched the OpenAI key pattern; the reason string contains
    // "secret" and the rule id is shown in parens.
    expect(why!.textContent).toContain("secret");
    expect(why!.textContent).toContain("secret.openai_key");

    findButton(card, "Deny").click();
    await pending;
  });

  it("falls back to the action-kind summary when classifier has no reason", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    // Clean `type` — classifier returns allow, but someone wired this
    // function for a belt-and-suspenders second prompt. Reason falls back.
    const pending = flow({ kind: "type", text: "just saying hello" });

    const card = host.children[0]!;
    const why = card.children.find((c) => c.className === "approval-args");
    expect(why!.textContent).toContain("type text");

    findButton(card, "Allow").click();
    await pending;
  });
});

describe("createComputerApprovalFlow — race safety", () => {
  it("ignores subsequent clicks after the first verdict (idempotent)", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "screenshot" });

    const card = host.children[0]!;
    const allow = findButton(card, "Allow");
    const deny = findButton(card, "Deny");

    allow.click(); // first, resolves the promise
    // A late deny click after the race shouldn't flip anything.
    deny.click();

    await expect(pending).resolves.toBe(true);
    expect(findVerdict(card)).toBe("Allowed");
  });

  it("tool-click after promise resolved does not add a second verdict", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "screenshot" });
    const card = host.children[0]!;
    findButton(card, "Allow").click();
    await pending;
    findButton(card, "Allow").click();
    // Exactly one verdict line.
    const verdicts = card.children.filter((c) => c.className === "approval-verdict");
    expect(verdicts).toHaveLength(1);
  });
});

describe("createComputerApprovalFlow — global document fallback", () => {
  it("uses globalThis.document when doc option is omitted", async () => {
    const originalDoc = (globalThis as { document?: unknown }).document;
    try {
      (globalThis as { document?: unknown }).document = makeDoc() as unknown;
      const host = makeHost();
      const flow = createComputerApprovalFlow({ renderHost: host });
      const pending = flow({ kind: "screenshot" });
      const card = host.children[0]!;
      expect(card.className).toBe("approval-card");
      findButton(card, "Allow").click();
      await expect(pending).resolves.toBe(true);
    } finally {
      if (originalDoc === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDoc;
      }
    }
  });
});

describe("createComputerApprovalFlow — renderHost.scrollTop", () => {
  it("scrolls the render host to keep the new card visible", async () => {
    const host = makeHost();
    host.scrollHeight = 1234;
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "screenshot" });
    expect(host.scrollTop).toBe(1234);
    const card = host.children[0]!;
    findButton(card, "Deny").click();
    await pending;
  });
});

describe("createComputerApprovalFlow — vi-spy allow-click", () => {
  it("allow handler does not throw when click fires after promise resolves (defensive)", async () => {
    const host = makeHost();
    const doc = makeDoc();
    const flow = createComputerApprovalFlow({ renderHost: host, doc });
    const pending = flow({ kind: "screenshot" });
    const card = host.children[0]!;
    findButton(card, "Deny").click();
    await pending;
    // Spy to prove the handler ran but didn't throw.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      findButton(card, "Allow").click();
    } finally {
      warn.mockRestore();
    }
  });
});
