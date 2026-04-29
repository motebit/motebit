/**
 * SkillsController unit tests. Covers:
 *
 *  - refresh() fetches through adapter; loading + error gates
 *  - install() forwards source to adapter; sets lastInstall; refresh on success
 *  - enable/disable optimistic mutation without full refresh
 *  - trust/untrust + remove trigger a full refresh (registry-side state shift)
 *  - verify mutates only the affected row's provenance_status
 *  - selectSkill loads detail; null clears
 *  - setSearch / filteredSkills client-side filter
 *  - errors surface in state.error and leave previous-good state intact
 *  - dispose blocks further actions
 */
import { describe, it, expect } from "vitest";
import {
  createSkillsController,
  filterSkillsView,
  type SkillDetail,
  type SkillInstallResult,
  type SkillProvenanceStatus,
  type SkillSummary,
  type SkillsInstallSource,
  type SkillsPanelAdapter,
} from "../controller.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    name: "placeholder",
    version: "1.0.0",
    description: "placeholder skill",
    enabled: true,
    trusted: false,
    provenance_status: "verified",
    sensitivity: "none",
    installed_at: "2026-04-29T00:00:00.000Z",
    source: "directory:/tmp/placeholder",
    ...overrides,
  };
}

function makeDetail(name: string, overrides?: Partial<SkillDetail>): SkillDetail {
  return {
    ...makeSummary({ name }),
    body: "# Procedure\nDo the thing.\n",
    author: "Test Author",
    category: "test",
    tags: ["test"],
    ...overrides,
  };
}

// ── Mock adapter ──────────────────────────────────────────────────────

interface AdapterOpts {
  initial?: SkillSummary[];
  detail?: Record<string, SkillDetail>;
  listThrows?: Error;
  installResult?: SkillInstallResult;
  installThrows?: Error;
  enableThrows?: Error;
  trustThrows?: Error;
  removeThrows?: Error;
  verifyResult?: SkillProvenanceStatus | "not_installed";
  verifyThrows?: Error;
}

interface AdapterCalls {
  list: number;
  detail: string[];
  install: SkillsInstallSource[];
  enable: string[];
  disable: string[];
  trust: string[];
  untrust: string[];
  remove: string[];
  verify: string[];
}

function createAdapter(opts: AdapterOpts = {}): {
  adapter: SkillsPanelAdapter;
  calls: AdapterCalls;
  /** Mutate the next list response (for testing refresh after registry-side change). */
  setSkills(next: SkillSummary[]): void;
} {
  let skills = opts.initial ?? [];
  const calls: AdapterCalls = {
    list: 0,
    detail: [],
    install: [],
    enable: [],
    disable: [],
    trust: [],
    untrust: [],
    remove: [],
    verify: [],
  };

  return {
    calls,
    setSkills(next) {
      skills = next;
    },
    adapter: {
      async listSkills() {
        calls.list++;
        if (opts.listThrows) throw opts.listThrows;
        return skills;
      },
      async readSkillDetail(name) {
        calls.detail.push(name);
        return opts.detail?.[name] ?? null;
      },
      async installFromSource(source) {
        calls.install.push(source);
        if (opts.installThrows) throw opts.installThrows;
        return (
          opts.installResult ?? {
            name: "installed-skill",
            version: "1.0.0",
            provenance_status: "verified" as const,
          }
        );
      },
      async enableSkill(name) {
        calls.enable.push(name);
        if (opts.enableThrows) throw opts.enableThrows;
      },
      async disableSkill(name) {
        calls.disable.push(name);
      },
      async trustSkill(name) {
        calls.trust.push(name);
        if (opts.trustThrows) throw opts.trustThrows;
      },
      async untrustSkill(name) {
        calls.untrust.push(name);
      },
      async removeSkill(name) {
        calls.remove.push(name);
        if (opts.removeThrows) throw opts.removeThrows;
      },
      async verifySkill(name) {
        calls.verify.push(name);
        if (opts.verifyThrows) throw opts.verifyThrows;
        return opts.verifyResult ?? "verified";
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("SkillsController — initial state", () => {
  it("starts empty, not loading, no error", () => {
    const { adapter } = createAdapter();
    const ctrl = createSkillsController(adapter);
    const s = ctrl.getState();
    expect(s.skills).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.selectedSkill).toBeNull();
    expect(s.lastInstall).toBeNull();
    expect(s.lastRemoval).toBeNull();
  });
});

describe("refresh()", () => {
  it("fetches skills via adapter and stores them in state", async () => {
    const skills = [makeSummary({ name: "a" }), makeSummary({ name: "b" })];
    const { adapter, calls } = createAdapter({ initial: skills });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    expect(calls.list).toBe(1);
    expect(ctrl.getState().skills).toEqual(skills);
    expect(ctrl.getState().loading).toBe(false);
  });

  it("surfaces errors in state.error and clears loading", async () => {
    const { adapter } = createAdapter({ listThrows: new Error("fs unreachable") });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe("fs unreachable");
    expect(ctrl.getState().loading).toBe(false);
  });

  it("notifies subscribers", async () => {
    const { adapter } = createAdapter({ initial: [makeSummary({ name: "a" })] });
    const ctrl = createSkillsController(adapter);
    let count = 0;
    ctrl.subscribe(() => count++);
    await ctrl.refresh();
    expect(count).toBeGreaterThanOrEqual(2); // loading=true, then loading=false+skills
  });
});

describe("install()", () => {
  it("forwards source to adapter and refreshes", async () => {
    const installed: SkillSummary = makeSummary({ name: "installed-skill" });
    const { adapter, calls, setSkills } = createAdapter();
    setSkills([]); // pre-install
    const ctrl = createSkillsController(adapter);
    setSkills([installed]); // post-install — refresh sees it
    await ctrl.install({ kind: "directory", path: "/tmp/x" });
    expect(calls.install).toEqual([{ kind: "directory", path: "/tmp/x" }]);
    expect(calls.list).toBe(1);
    expect(ctrl.getState().lastInstall).toMatchObject({ name: "installed-skill" });
    expect(ctrl.getState().skills).toEqual([installed]);
  });

  it("surfaces install errors in state.error without refreshing", async () => {
    const { adapter, calls } = createAdapter({ installThrows: new Error("bad envelope") });
    const ctrl = createSkillsController(adapter);
    await ctrl.install({ kind: "directory", path: "/tmp/x" });
    expect(ctrl.getState().error).toBe("bad envelope");
    expect(ctrl.getState().lastInstall).toBeNull();
    expect(calls.list).toBe(0);
  });
});

describe("enable / disable", () => {
  it("optimistically flips enabled flag without a full refresh", async () => {
    const { adapter, calls } = createAdapter({
      initial: [makeSummary({ name: "a", enabled: true })],
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.disableSkill("a");
    expect(calls.disable).toEqual(["a"]);
    expect(ctrl.getState().skills[0]!.enabled).toBe(false);
    expect(calls.list).toBe(1); // no extra list

    await ctrl.enableSkill("a");
    expect(calls.enable).toEqual(["a"]);
    expect(ctrl.getState().skills[0]!.enabled).toBe(true);
    expect(calls.list).toBe(1);
  });
});

describe("trust / untrust", () => {
  it("triggers a full refresh after promotion (registry recomputes provenance)", async () => {
    const { adapter, calls, setSkills } = createAdapter({
      initial: [makeSummary({ name: "a", trusted: false, provenance_status: "unsigned" })],
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    setSkills([makeSummary({ name: "a", trusted: true, provenance_status: "trusted_unsigned" })]);
    await ctrl.trustSkill("a");
    expect(calls.trust).toEqual(["a"]);
    expect(calls.list).toBe(2); // initial + post-trust refresh
    expect(ctrl.getState().skills[0]!.provenance_status).toBe("trusted_unsigned");
  });
});

describe("removeSkill", () => {
  it("records lastRemoval, clears selectedSkill if it matched, and refreshes", async () => {
    const { adapter, setSkills } = createAdapter({
      initial: [makeSummary({ name: "a" }), makeSummary({ name: "b" })],
      detail: { a: makeDetail("a") },
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.selectSkill("a");
    expect(ctrl.getState().selectedSkill?.name).toBe("a");

    setSkills([makeSummary({ name: "b" })]);
    await ctrl.removeSkill("a");
    expect(ctrl.getState().lastRemoval).toEqual({ name: "a", version: "1.0.0" });
    expect(ctrl.getState().selectedSkill).toBeNull();
    expect(ctrl.getState().skills).toHaveLength(1);
  });

  it("does not clear selectedSkill if a different skill is removed", async () => {
    const { adapter, setSkills } = createAdapter({
      initial: [makeSummary({ name: "a" }), makeSummary({ name: "b" })],
      detail: { b: makeDetail("b") },
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.selectSkill("b");
    setSkills([makeSummary({ name: "b" })]);
    await ctrl.removeSkill("a");
    expect(ctrl.getState().selectedSkill?.name).toBe("b");
  });
});

describe("verifySkill", () => {
  it("syncs only the affected row's provenance_status", async () => {
    const { adapter, calls } = createAdapter({
      initial: [
        makeSummary({ name: "a", provenance_status: "verified" }),
        makeSummary({ name: "b", provenance_status: "verified" }),
      ],
      verifyResult: "unverified",
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.verifySkill("a");
    expect(calls.verify).toEqual(["a"]);
    expect(ctrl.getState().skills.find((s) => s.name === "a")!.provenance_status).toBe(
      "unverified",
    );
    expect(ctrl.getState().skills.find((s) => s.name === "b")!.provenance_status).toBe("verified");
  });

  it("surfaces not_installed as an error", async () => {
    const { adapter } = createAdapter({
      initial: [makeSummary({ name: "a" })],
      verifyResult: "not_installed",
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.verifySkill("nonexistent");
    expect(ctrl.getState().error).toContain("not installed");
  });
});

describe("selectSkill", () => {
  it("loads detail and sets selectedSkill", async () => {
    const { adapter } = createAdapter({
      initial: [makeSummary({ name: "a" })],
      detail: { a: makeDetail("a", { body: "# Skill A\n" }) },
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.selectSkill("a");
    expect(ctrl.getState().selectedSkill?.body).toContain("Skill A");
  });

  it("null clears the detail view", async () => {
    const { adapter } = createAdapter({
      initial: [makeSummary({ name: "a" })],
      detail: { a: makeDetail("a") },
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    await ctrl.selectSkill("a");
    await ctrl.selectSkill(null);
    expect(ctrl.getState().selectedSkill).toBeNull();
  });
});

describe("setSearch + filteredSkills", () => {
  it("filters by name (case-insensitive substring)", () => {
    const { adapter } = createAdapter({
      initial: [
        makeSummary({ name: "git-commit-helper", description: "..." }),
        makeSummary({ name: "lint-fix", description: "..." }),
      ],
    });
    const ctrl = createSkillsController(adapter);
    void ctrl.refresh().then(() => {
      ctrl.setSearch("LINT");
      expect(ctrl.filteredSkills().map((s) => s.name)).toEqual(["lint-fix"]);
    });
  });

  it("filters by description", async () => {
    const { adapter } = createAdapter({
      initial: [
        makeSummary({ name: "a", description: "for git workflows" }),
        makeSummary({ name: "b", description: "for lint cleanup" }),
      ],
    });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    ctrl.setSearch("workflow");
    expect(ctrl.filteredSkills().map((s) => s.name)).toEqual(["a"]);
  });

  it("empty query returns full list", async () => {
    const skills = [makeSummary({ name: "a" }), makeSummary({ name: "b" })];
    const { adapter } = createAdapter({ initial: skills });
    const ctrl = createSkillsController(adapter);
    await ctrl.refresh();
    ctrl.setSearch("");
    expect(ctrl.filteredSkills()).toHaveLength(2);
  });

  it("filterSkillsView works as a pure export (no controller needed)", () => {
    const skills = [
      makeSummary({ name: "a", description: "x" }),
      makeSummary({ name: "b", description: "y" }),
    ];
    expect(filterSkillsView(skills, "a").map((s) => s.name)).toEqual(["a"]);
  });
});

describe("dispose", () => {
  it("blocks subsequent actions with a clear error", async () => {
    const { adapter } = createAdapter();
    const ctrl = createSkillsController(adapter);
    ctrl.dispose();
    await expect(ctrl.refresh()).rejects.toThrow("disposed");
  });
});
