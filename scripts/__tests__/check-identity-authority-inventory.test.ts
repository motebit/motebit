/**
 * check-identity-authority-inventory — the census-freshness gate (Inc 0 of
 * docs/design/identity-authority-writers.md). The stale verdict and its
 * failure block are pure; the live run proves the committed census is fresh
 * and that a passing run states its aperture.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  censusDrift,
  coverageReport,
  declaredAuthorityColumns,
  guardCoverageDrift,
  singleWriterProblems,
  singleWriterReport,
  staleReport,
  type AuthorityWriterSite,
} from "../check-identity-authority-inventory.js";
import { formatRepair, hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const ROOT = resolve(__dirname, "..", "..");

describe("censusDrift", () => {
  it("is empty for an identical census", () => {
    expect(censusDrift("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("names the changed line on both sides", () => {
    const drift = censusDrift("| writers | 307 |\n", "| writers | 308 |\n");
    expect(drift).toEqual([
      "line 1 committed: | writers | 307 |",
      "line 1 fresh:     | writers | 308 |",
    ]);
  });

  it("reports an added trailing row and caps the list", () => {
    const fresh = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    const drift = censusDrift("", fresh);
    expect(drift.length).toBe(12);
    expect(drift[0]).toBe("line 1 committed: ");
  });

  it("is non-empty for a whitespace-only difference", () => {
    expect(censusDrift("a\n", "a\n\n").length).toBeGreaterThan(0);
  });
});

describe("staleReport", () => {
  it("satisfies the repair-instruction contract", () => {
    const out = formatRepair(staleReport("docs/x.generated.md", ["line 1 …"], "3 files scanned"));
    expect(hasRepairInstruction(out)).toEqual({ ok: true });
    expect(out).toContain("npx tsx scripts/inventory-identity-authority.ts");
    expect(out).toContain("line 1 …");
  });
});

describe("shadow-guard coverage (identity-authority Inc 2)", () => {
  const SRC = `export const AUTHORITY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agent_registry: [
    "public_key",
    "settlement_address",
  ],
  devices: ["public_key"],
};
export const OTHER = { x: ["y"] };`;

  it("reads the declared table.column pairs from the source text, and nothing after the literal", () => {
    expect(declaredAuthorityColumns(SRC)).toEqual([
      "agent_registry.public_key",
      "agent_registry.settlement_address",
      "devices.public_key",
    ]);
    expect(declaredAuthorityColumns("const nothing = 1;")).toEqual([]);
  });

  it("an authority column the guard omits is UNGUARDED; a declared non-authority column is STALE", () => {
    const census = [
      "agent_registry.public_key",
      "agent_registry.settlement_address",
      "devices.public_key",
    ];
    expect(guardCoverageDrift(census, declaredAuthorityColumns(SRC))).toEqual([]);
    const drift = guardCoverageDrift(
      [...census, "relay_withdrawals.destination"],
      [...declaredAuthorityColumns(SRC), "agent_registry.metadata"],
    );
    expect(drift).toEqual([
      "UNGUARDED: relay_withdrawals.destination is authority-bearing in the census but not in AUTHORITY_COLUMNS",
      "STALE: agent_registry.metadata is in AUTHORITY_COLUMNS but not authority-bearing in the census",
    ]);
    const out = formatRepair(coverageReport(drift));
    expect(hasRepairInstruction(out)).toEqual({ ok: true });
    expect(out).toContain("AUTHORITY_COLUMNS");
  });
});

describe("one writer (identity-authority Inc 2, I1)", () => {
  const W = "services/relay/src/identity-authority.ts";
  const reg = [
    {
      file: "services/relay/src/a.ts",
      fn: "f",
      write: "UPDATE agent_registry",
      count: 1,
      why: "x",
    },
  ];

  it("writes inside the single writer never count; registered outside writes pass at their count", () => {
    expect(
      singleWriterProblems(
        [
          { file: W, fn: "applyChange", write: "UPDATE agent_registry" },
          { file: W, fn: "applyChange", write: "INSERT relay_service_listings" },
          { file: "services/relay/src/a.ts", fn: "f", write: "UPDATE agent_registry" },
        ],
        reg,
      ),
    ).toEqual([]);
  });

  it("a NEW writer elsewhere, a SECOND writer in a registered function, and a stale entry are each named", () => {
    expect(
      singleWriterProblems(
        [{ file: "services/relay/src/b.ts", fn: "g", write: "UPDATE agent_registry" }],
        reg,
      ),
    ).toEqual([
      "NEW authority writer outside the single writer: services/relay/src/b.ts | g | UPDATE agent_registry",
      "STALE entry: services/relay/src/a.ts | f | UPDATE agent_registry — 1 registered, 0 found; lower or delete it",
    ]);
    expect(
      singleWriterProblems(
        [
          { file: "services/relay/src/a.ts", fn: "f", write: "UPDATE agent_registry" },
          { file: "services/relay/src/a.ts", fn: "f", write: "UPDATE agent_registry" },
        ],
        reg,
      ),
    ).toEqual([
      "NEW authority writer outside the single writer: services/relay/src/a.ts | f | UPDATE agent_registry (2 found, 1 registered)",
    ]);
  });

  // F3 (Inc 2 cold review): the exemption is the writer's DECLARATIONS, never
  // the whole file; and a registered writer is registered with the authority
  // COLUMNS it writes, so one that starts writing another column fails.
  const site = (file: string, fn: string, write: string, columns: string[]) =>
    ({ file, fn, write, columns }) as AuthorityWriterSite;

  it("tamper (a): a NEW raw writer in identity-authority.ts outside writeAuthority/applyChange fails", () => {
    expect(
      singleWriterProblems(
        [
          site(W, "applyChange", "UPDATE agent_registry", ["sweep_threshold"]),
          site(W, "sneakySetPayTo", "UPDATE relay_service_listings", ["pay_to_address"]),
        ],
        [],
      ),
    ).toEqual([
      "NEW authority writer outside the single writer: services/relay/src/identity-authority.ts | sneakySetPayTo | UPDATE relay_service_listings [pay_to_address]",
    ]);
  });

  it("tamper (b): a registered writer that starts writing a NEW authority column fails", () => {
    const registered = [
      {
        file: "services/relay/src/a.ts",
        fn: "f",
        write: "UPDATE agent_registry",
        columns: ["public_key"],
        count: 1,
        why: "x",
      },
    ];
    expect(
      singleWriterProblems(
        [site("services/relay/src/a.ts", "f", "UPDATE agent_registry", ["public_key"])],
        registered,
      ),
    ).toEqual([]);
    expect(
      singleWriterProblems(
        [
          site("services/relay/src/a.ts", "f", "UPDATE agent_registry", [
            "public_key",
            "settlement_address",
          ]),
        ],
        registered,
      ),
    ).toEqual([
      "NEW authority writer outside the single writer: services/relay/src/a.ts | f | UPDATE agent_registry [public_key, settlement_address]",
      "STALE entry: services/relay/src/a.ts | f | UPDATE agent_registry [public_key] — 1 registered, 0 found; lower or delete it",
    ]);
  });

  it("the failure names writeAuthority and satisfies the repair-instruction contract", () => {
    const out = formatRepair(
      singleWriterReport(["NEW authority writer outside the single writer: x"], "3 files"),
    );
    expect(hasRepairInstruction(out)).toEqual({ ok: true });
    expect(out).toContain("writeAuthority");
  });
});

describe("live run", () => {
  it("passes on the committed census and discloses its aperture", () => {
    const r = spawnSync(
      resolve(ROOT, "node_modules", ".bin", "tsx"),
      ["scripts/check-identity-authority-inventory.ts"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(hasApertureDisclosure(r.stdout)).toEqual({ ok: true });
    expect(r.stdout).toMatch(/\d+ files scanned/);
  }, 60_000);
});
