/**
 * `parseArgs` branch coverage — the CLI's front door, in-process.
 *
 * Context (#568): `src/cli.ts` sat in `coverageExclude` described as "the
 * #!/usr/bin/env node bin shim". It is 1050 lines carrying ~190 control-flow
 * statements, and excluding it meant the package's 90/75/100/90 thresholds
 * were enforced against 8 statements in `adapters.ts` — 2.3% of the package.
 * The thresholds were real (a deliberate severing fails them), but they
 * guarded almost nothing, and the coverage-graduation entry named "the CLI's
 * unsupported-suite / post-quantum-pending branches" as its lever while the
 * file those branches live in was excluded from measurement.
 *
 * The existing CLI tests are hybrid: they import a few exported helpers
 * in-process, then drive end-to-end behaviour through `spawnSync`. The
 * subprocess half is real verification but is invisible to v8 instrumentation
 * in the parent, so the measured number understates what is actually tested.
 * These tests deliberately take the in-process path only — `parseArgs` is
 * pure (argv in, ParsedArgs out, no I/O), so every branch is reachable
 * without spawning anything, and every branch reached is a branch counted.
 *
 * Argument parsing is also where CLI defects concentrate: a flag that
 * silently swallows the next argument, or an unvalidated value reaching the
 * verifier, is a wrong ANSWER from a tool whose whole purpose is answering
 * "is this artifact authentic". The error branches matter more than the
 * happy path here, so they are enumerated rather than sampled.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";

/** A syntactically valid 32-byte Ed25519 key in hex — content is irrelevant. */
const VALID_KEY_HEX = "a".repeat(64);

describe("parseArgs — verify mode", () => {
  it("returns help for -h and --help", () => {
    for (const flag of ["-h", "--help"]) {
      const parsed = parseArgs([flag]);
      expect(parsed.mode).toBe("help");
      expect(parsed.usageError).toBeUndefined();
    }
  });

  it("returns version for -V and --version", () => {
    for (const flag of ["-V", "--version"]) {
      expect(parseArgs([flag]).mode).toBe("version");
    }
  });

  it("help wins over a file argument", () => {
    // Ordering must not matter: asking for help never runs a verification.
    expect(parseArgs(["artifact.json", "--help"]).mode).toBe("help");
    expect(parseArgs(["--help", "artifact.json"]).mode).toBe("help");
  });

  it("help wins over version", () => {
    expect(parseArgs(["--version", "--help"]).mode).toBe("help");
  });

  it("carries --json through to help and version", () => {
    expect(parseArgs(["--json", "--help"]).json).toBe(true);
    expect(parseArgs(["--json", "--version"]).json).toBe(true);
  });

  it("parses a bare file argument", () => {
    const parsed = parseArgs(["artifact.json"]);
    expect(parsed.mode).toBe("verify");
    expect(parsed.file).toBe("artifact.json");
    expect(parsed.json).toBe(false);
  });

  it("sets --strict and --json", () => {
    const parsed = parseArgs(["--strict", "--json", "artifact.json"]);
    expect(parsed.mode).toBe("verify");
    expect(parsed.strictHashBinding).toBe(true);
    expect(parsed.json).toBe(true);
  });

  it("errors when no file is given", () => {
    expect(parseArgs([]).usageError).toMatch(/missing file argument/);
    expect(parseArgs(["--json"]).usageError).toMatch(/missing file argument/);
  });

  it("errors on a second file argument", () => {
    const parsed = parseArgs(["one.json", "two.json"]);
    expect(parsed.usageError).toMatch(/exactly one file argument/);
    // The message names BOTH files — a caller who fat-fingered a glob needs
    // to see which two collided, not just that two arrived.
    expect(parsed.usageError).toContain("two.json");
    expect(parsed.usageError).toContain("one.json");
  });

  it("errors on an unknown flag", () => {
    expect(parseArgs(["--nope", "artifact.json"]).usageError).toMatch(/unknown flag: --nope/);
  });

  describe("--expect / --expected-type", () => {
    it("accepts every declared artifact type under both spellings", () => {
      for (const flag of ["--expect", "--expected-type"]) {
        const parsed = parseArgs([flag, "receipt", "artifact.json"]);
        expect(parsed.mode).toBe("verify");
        expect(parsed.expectedType).toBe("receipt");
      }
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["--expect"]).usageError).toMatch(/--expect requires a value/);
      expect(parseArgs(["--expected-type"]).usageError).toMatch(/--expected-type requires a value/);
    });

    it("errors on an unknown type and lists the valid ones", () => {
      const parsed = parseArgs(["--expect", "not-a-type", "artifact.json"]);
      expect(parsed.usageError).toMatch(/unknown --expect value "not-a-type"/);
      // The repair instruction must carry the vocabulary, not just the rejection.
      expect(parsed.usageError).toContain("receipt");
    });
  });

  describe("--clock-skew", () => {
    it("accepts a non-negative integer, including zero", () => {
      expect(parseArgs(["--clock-skew", "0", "a.json"]).clockSkewSeconds).toBe(0);
      expect(parseArgs(["--clock-skew", "300", "a.json"]).clockSkewSeconds).toBe(300);
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["--clock-skew"]).usageError).toMatch(/--clock-skew requires an integer/);
    });

    it("rejects a non-numeric value", () => {
      expect(parseArgs(["--clock-skew", "soon", "a.json"]).usageError).toMatch(
        /--clock-skew must be a non-negative integer/,
      );
    });

    it("rejects a negative value", () => {
      // A negative skew would widen the acceptance window in the wrong
      // direction — it must not be quietly coerced.
      expect(parseArgs(["--clock-skew", "-5", "a.json"]).usageError).toMatch(
        /non-negative integer/,
      );
    });
  });

  describe("platform override flags", () => {
    it("parses --bundle-id, --rp-id and --android-attestation-application-id", () => {
      const parsed = parseArgs([
        "--bundle-id",
        "com.example.app",
        "--rp-id",
        "example.com",
        "--android-attestation-application-id",
        "/tmp/aaid.bin",
        "artifact.json",
      ]);
      expect(parsed.mode).toBe("verify");
      expect(parsed.bundleId).toBe("com.example.app");
      expect(parsed.rpId).toBe("example.com");
      expect(parsed.androidAttestationApplicationIdPath).toBe("/tmp/aaid.bin");
    });

    it("errors when any of them is missing its value", () => {
      expect(parseArgs(["--bundle-id"]).usageError).toMatch(/--bundle-id requires a value/);
      expect(parseArgs(["--rp-id"]).usageError).toMatch(/--rp-id requires a value/);
      expect(parseArgs(["--android-attestation-application-id"]).usageError).toMatch(
        /requires a path to a binary file/,
      );
    });
  });
});

describe("parseArgs — content-artifact subcommand", () => {
  it("parses a body file plus --manifest", () => {
    const parsed = parseArgs(["content-artifact", "body.bin", "--manifest", "header-or-path"]);
    expect(parsed.mode).toBe("verify-content-artifact");
    expect(parsed.file).toBe("body.bin");
    expect(parsed.manifest).toBe("header-or-path");
  });

  it("returns help without requiring the otherwise-mandatory arguments", () => {
    expect(parseArgs(["content-artifact", "-h"]).mode).toBe("help");
    expect(parseArgs(["content-artifact", "--help"]).mode).toBe("help");
  });

  it("errors when the body file is missing", () => {
    expect(parseArgs(["content-artifact", "--manifest", "m"]).usageError).toMatch(
      /missing body-file argument/,
    );
  });

  it("errors when --manifest is missing", () => {
    // Both halves are required: bytes with no manifest cannot be checked
    // against anything.
    expect(parseArgs(["content-artifact", "body.bin"]).usageError).toMatch(
      /--manifest is required/,
    );
  });

  it("errors when --manifest has no value", () => {
    expect(parseArgs(["content-artifact", "--manifest"]).usageError).toMatch(
      /--manifest requires a value/,
    );
  });

  it("errors on a second body-file argument", () => {
    expect(parseArgs(["content-artifact", "a.bin", "b.bin"]).usageError).toMatch(
      /exactly one body-file argument/,
    );
  });

  it("errors on an unknown flag", () => {
    expect(parseArgs(["content-artifact", "--nope"]).usageError).toMatch(/unknown flag: --nope/);
  });

  it("carries --json", () => {
    const parsed = parseArgs(["content-artifact", "--json", "b.bin", "--manifest", "m"]);
    expect(parsed.json).toBe(true);
  });

  describe("--expect", () => {
    it("accepts a real content-artifact type", () => {
      const parsed = parseArgs([
        "content-artifact",
        "b.bin",
        "--manifest",
        "m",
        "--expect",
        "execution-ledger",
      ]);
      expect(parsed.expectedArtifactType).toBe("execution-ledger");
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["content-artifact", "--expect"]).usageError).toMatch(/requires a value/);
    });

    it("rejects a type that is not a content-artifact type", () => {
      // "receipt" is a valid --expect for the base verify mode and NOT valid
      // here; the two vocabularies must not bleed into each other.
      const parsed = parseArgs(["content-artifact", "b.bin", "--expect", "receipt"]);
      expect(parsed.usageError).toMatch(/unknown --expect value "receipt"/);
    });
  });

  describe("--producer-key", () => {
    it("accepts 64 hex characters and normalizes to lowercase", () => {
      const parsed = parseArgs([
        "content-artifact",
        "b.bin",
        "--manifest",
        "m",
        "--producer-key",
        "A".repeat(64),
      ]);
      // Case-normalizing at the boundary is what makes the later
      // pinned-key comparison a plain string equality.
      expect(parsed.expectedProducerKey).toBe("a".repeat(64));
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["content-artifact", "--producer-key"]).usageError).toMatch(
        /--producer-key requires a hex value/,
      );
    });

    it("rejects a key that is not 64 hex characters", () => {
      for (const bad of ["deadbeef", "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
        expect(parseArgs(["content-artifact", "b.bin", "--producer-key", bad]).usageError).toMatch(
          /64 hex characters/,
        );
      }
    });
  });
});

describe("parseArgs — approval-decision subcommand", () => {
  it("parses a decision file", () => {
    const parsed = parseArgs(["approval-decision", "decision.json"]);
    expect(parsed.mode).toBe("verify-approval-decision");
    expect(parsed.file).toBe("decision.json");
  });

  it("returns help", () => {
    expect(parseArgs(["approval-decision", "-h"]).mode).toBe("help");
    expect(parseArgs(["approval-decision", "--help"]).mode).toBe("help");
  });

  it("errors when the decision file is missing", () => {
    expect(parseArgs(["approval-decision"]).usageError).toMatch(/missing decision-file argument/);
  });

  it("errors on a second file argument", () => {
    expect(parseArgs(["approval-decision", "a.json", "b.json"]).usageError).toMatch(/exactly one/);
  });

  it("errors on an unknown flag", () => {
    expect(parseArgs(["approval-decision", "--nope"]).usageError).toMatch(/unknown flag: --nope/);
  });

  it("carries --json", () => {
    expect(parseArgs(["approval-decision", "--json", "d.json"]).json).toBe(true);
  });

  describe("--producer-key", () => {
    it("accepts 64 hex characters", () => {
      const parsed = parseArgs(["approval-decision", "d.json", "--producer-key", VALID_KEY_HEX]);
      expect(parsed.expectedProducerKey).toBe(VALID_KEY_HEX);
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["approval-decision", "--producer-key"]).usageError).toMatch(
        /requires a hex value/,
      );
    });

    it("rejects a malformed key", () => {
      expect(
        parseArgs(["approval-decision", "d.json", "--producer-key", "nope"]).usageError,
      ).toMatch(/64 hex characters/);
    });
  });

  describe("--expect-verdict", () => {
    it("accepts approved and denied", () => {
      for (const verdict of ["approved", "denied"]) {
        const parsed = parseArgs(["approval-decision", "d.json", "--expect-verdict", verdict]);
        expect(parsed.usageError).toBeUndefined();
        expect(parsed.mode).toBe("verify-approval-decision");
      }
    });

    it("errors when the value is missing", () => {
      expect(parseArgs(["approval-decision", "--expect-verdict"]).usageError).toMatch(
        /requires a value \(approved\|denied\)/,
      );
    });

    it("rejects any other verdict", () => {
      // A typo'd verdict must not degrade into "no expectation" — that would
      // silently pass a decision the caller meant to constrain.
      const parsed = parseArgs(["approval-decision", "d.json", "--expect-verdict", "maybe"]);
      expect(parsed.usageError).toMatch(/must be "approved" or "denied"/);
    });
  });
});
