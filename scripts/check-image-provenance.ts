#!/usr/bin/env tsx
/**
 * check-image-provenance — is the container image an operator is told to pull
 * published, signed, and bound to the commit it claims? (#722.)
 *
 * The third EXTERNAL drift gate, after `check-model-catalog-drift` (the
 * provider's live model catalog) and `check-deploy-freshness` (the running Fly
 * fleet). Those two point at what is SERVED; this one points at what is
 * DISTRIBUTED. `docs/operator/self-host.md` hands a third-party operator a tag
 * to pull and a `cosign verify` command to run against it, and until now
 * nothing in the repo asked whether either still works.
 *
 * ## The incident that named it
 *
 * On 2026-09-21 the publish job hit its 30-minute ceiling after pushing the
 * image and before signing it. GitHub reports a job timeout as `cancelled`,
 * not `failure` — so it read like somebody pressed a button, nothing alerted,
 * and `ghcr.io/motebit/relay:main` spent hours pointing at an unsigned,
 * unattested image that was indistinguishable from a real release. #723 fixed
 * the ordering (alias tags are now applied only to an already-signed digest),
 * which closes the mechanism. This gate closes the BLINDNESS: the repo could
 * not see what it had published, so a second mechanism failing the same way
 * would be equally invisible.
 *
 * Failing open is the sharp part. A missing signature is not a missing tag —
 * `docker pull` succeeds, the container runs, and nothing about the image says
 * the guarantee this project's own workflow header promises is absent.
 *
 * ## What it asserts, per documented tag
 *
 *   EXISTS      the tag resolves to a manifest digest in the registry.
 *               Anonymous pull token — no secret, no `docker login`.
 *   SIGNED      the signature verifies, AND the signature's subject digest is
 *               the digest the tag currently resolves to (a signature over
 *               some other manifest proves nothing about what is served now).
 *   ATTESTED    the SLSA build provenance verifies, its subject digest matches,
 *               and its `resolvedDependencies[].digest.gitCommit` is the commit
 *               the tag claims — `:main` and `sha-<short>` claim main's HEAD, a
 *               release tag claims the commit `relay-vX.Y.Z` points at.
 *   ALIAS       `:main` resolves to the SAME digest as `sha-<short>` for HEAD.
 *               This is #723's ordering invariant, checked where it lands
 *               rather than where it is written.
 *   PUBLISHED   the newest `publish-images` run for HEAD concluded `success`.
 *               Any other terminal conclusion is red, INCLUDING `cancelled` —
 *               that is the conclusion a timeout produces, and the one nothing
 *               was watching. A run still in progress is not a finding; the
 *               HEAD-derived targets are skipped with that stated as the
 *               reason, because a build that has not finished has not failed.
 *
 * ## The commands are READ, not retyped
 *
 * The cosign invocations come from the fenced block in
 * `docs/operator/self-host.md` § "Verify before you run", parsed and run with
 * the image reference substituted per target. The gate deliberately does not
 * carry its own copy: a verification that works here and a DIFFERENT one in
 * the docs would leave the operator-facing command unchecked, which is most of
 * the exposure. Running the documented command is what caught its predicate
 * type being wrong (`--type slsaprovenance` selects SLSA v0.2; the workflow's
 * `actions/attest-build-provenance` emits v1, so the documented command failed
 * against every image motebit has ever published, while the signature half
 * beside it passed).
 *
 * ## Not in `pnpm check`
 *
 * Network, `cosign`, and (for the publish-run conclusion) `gh`. Runs daily from
 * `.github/workflows/image-provenance.yml`. With `--require-tools` a missing
 * prerequisite is RED, never a silent skip — a dormant external gate is the
 * flaw class `docs/doctrine/composition-preserves-enforcement.md` names, and
 * the one #632 let sit unseen for five weeks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";
import { readPushTrigger } from "./lib/workflow-triggers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** CI mode: a missing prerequisite is a finding, not a polite skip. */
const REQUIRE_TOOLS = process.argv.includes("--require-tools");

/**
 * Per-cosign-invocation ceiling. `cosign --timeout` does not cover the
 * transparency-log path (a 120s flag sat at five minutes on a local run), so
 * the ceiling is imposed here. Generous, because the round-trips are
 * Sigstore's and a slow day is not a finding about the image.
 */
const COSIGN_TIMEOUT_MS = Number(process.env["IMAGE_PROVENANCE_TIMEOUT_MS"] ?? "300000");

/** The operator-facing docs this gate reads its targets and commands out of. */
const VERIFY_DOC = "docs/operator/self-host.md";
const REF_SOURCES = ["README.md", VERIFY_DOC, "docs/operator/docker-compose.example.yml"];

const IMAGE_REPO = "ghcr.io/motebit/relay";

interface Finding {
  ref: string;
  kind: "absent" | "unsigned" | "unattested" | "unverified" | "mismatch" | "publish";
  detail: string;
}

// ── The documented commands ────────────────────────────────────────────────

interface VerifyCommand {
  kind: "signature" | "attestation";
  /** argv as the docs write it, image reference included. */
  argv: string[];
  /** Index into argv of the `ghcr.io/...` reference, for substitution. */
  refIndex: number;
}

/**
 * Split a shell line into argv, honouring single and double quotes. The
 * documented commands quote their regexps (they contain `*` and `@`), so a
 * whitespace split would hand cosign a broken identity pattern and the gate
 * would report every image unsigned. Deliberately minimal: no expansion, no
 * substitution, no operators — if the docs ever grow a command needing those,
 * this should fail to parse rather than guess.
 */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur !== "") out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur !== "") out.push(cur);
  return out;
}

/** The first ```…``` block inside the section a heading opens, or null. */
function fencedBlockUnder(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const body: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line) && !inFence) break;
    if (/^```/.test(line)) {
      if (inFence) break;
      inFence = true;
      continue;
    }
    if (inFence) body.push(line);
  }
  return body.length > 0 ? body.join("\n") : null;
}

/**
 * The cosign commands the operator docs hand a third-party operator.
 *
 * Both kinds are REQUIRED. If the attestation command ever disappears from the
 * docs, this gate must not quietly shrink to half its aperture — the tags would
 * keep passing and nobody would learn that provenance stopped being checked.
 */
function operatorVerifyCommands(): VerifyCommand[] {
  const path = join(ROOT, VERIFY_DOC);
  const block = existsSync(path)
    ? fencedBlockUnder(readFileSync(path, "utf-8"), "## Verify before you run")
    : null;
  const commands: VerifyCommand[] = [];
  if (block !== null) {
    // Join backslash continuations, then keep the cosign lines.
    for (const raw of block.replace(/\\\n\s*/g, " ").split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("cosign ")) continue;
      const argv = tokenize(line);
      const refIndex = argv.findIndex((t) => t.startsWith(`${IMAGE_REPO}:`));
      if (refIndex === -1) continue;
      const kind =
        argv[1] === "verify"
          ? ("signature" as const)
          : argv[1] === "verify-attestation"
            ? ("attestation" as const)
            : null;
      if (kind === null) continue;
      if (!commands.some((c) => c.kind === kind)) commands.push({ kind, argv, refIndex });
    }
  }
  if (commands.length !== 2) {
    failWithRepair({
      invariant: `check-image-provenance could not read both operator verify commands out of ${VERIFY_DOC}`,
      canonical: VERIFY_DOC,
      fix: `Restore a \`\`\`bash block under the "## Verify before you run" heading containing both a \`cosign verify ${IMAGE_REPO}:<tag> …\` and a \`cosign verify-attestation ${IMAGE_REPO}:<tag> …\` line. This gate runs the documented commands rather than its own copy, so an operator command it cannot read is an operator command nothing checks. Found: ${commands.length === 0 ? "neither" : commands.map((c) => c.kind).join(", ")}.`,
      doctrine:
        "docs/doctrine/self-attesting-system.md — a published verification command is a claim, and every claim is user-verifiable.",
    });
  }
  return commands;
}

/**
 * Every `cosign verify…` line anywhere in a file, as argv.
 *
 * Used to hold the SECOND publication of the operator command to the first.
 * The README repeats the signature command beside the badge, and two copies of
 * a security instruction drift — one of them silently stops being the one
 * anybody runs. Docs are siblings of code (`CLAUDE.md` § Sibling boundary
 * rule), and this is the sibling audit done mechanically.
 */
function cosignLines(markdown: string): string[][] {
  const out: string[][] = [];
  for (const raw of markdown.replace(/\\\n\s*/g, " ").split("\n")) {
    const line = raw.trim().replace(/^[$>]\s*/, "");
    if (!line.startsWith("cosign ")) continue;
    const argv = tokenize(line);
    if (argv.some((t) => t.startsWith(`${IMAGE_REPO}:`))) out.push(argv);
  }
  return out;
}

/**
 * The operator verify command is published in ONE shape. A second copy that
 * has drifted is a command some readers run and others do not, and the
 * verification it performs is whatever that copy happens to say.
 */
function assertCommandParity(canonical: VerifyCommand[]): number {
  let compared = 0;
  for (const rel of REF_SOURCES) {
    if (rel === VERIFY_DOC) continue;
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    for (const argv of cosignLines(readFileSync(path, "utf-8"))) {
      const match = canonical.find((c) => c.argv[1] === argv[1]);
      if (match === undefined) continue;
      compared++;
      const strip = (a: string[]) => a.filter((t) => !t.startsWith(`${IMAGE_REPO}:`)).join(" ");
      if (strip(argv) !== strip(match.argv)) {
        failWithRepair({
          invariant: `the operator \`cosign ${argv[1]}\` command is published in two different shapes`,
          sites: [`${rel}: ${strip(argv)}`, `${VERIFY_DOC}: ${strip(match.argv)}`],
          canonical: VERIFY_DOC,
          fix: `Make the copy in ${rel} identical to the one in ${VERIFY_DOC} (the image reference may differ; every flag must not). A verification instruction with two shapes is two different verifications, and only one of them is the one this gate runs.`,
          doctrine: "CLAUDE.md § Sibling boundary rule — docs are siblings of code.",
        });
      }
    }
  }
  return compared;
}

// ── The documented targets ─────────────────────────────────────────────────

interface Target {
  /** Set when a docs-named X.Y.Z has no visible `relay-vX.Y.Z` tag to bind to. */
  unresolvedTag?: string;
  /** Tag only, e.g. `1.0.1`, `main`, `sha-4fa5fbb`. */
  tag: string;
  /** Where the operator is told about it. */
  sources: string[];
  /** The commit this tag claims to be built from, when the repo can say. */
  expectCommit: string | null;
  /** True for tags derived from main's HEAD, which a running build may not have yet. */
  fromHead: boolean;
}

function gitOut(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every `ghcr.io/motebit/relay:<tag>` an operator-facing document names, plus
 * the two tags every push to main publishes.
 *
 * Read from the docs rather than listed here on purpose: a hardcoded list
 * narrows silently as the docs grow, which is aperture drift
 * (`docs/doctrine/gate-repair-instructions.md`). Placeholder rows in the tag
 * table (`:X.Y.Z`, `:sha-<short>`) are skipped — they are documentation of a
 * SHAPE, not a tag anyone can pull.
 */
/** Set when no `relay-v*` tag is visible — reported, never silently dropped. */
let missingReleaseTag = false;

function targets(head: string | null): Target[] {
  const byTag = new Map<string, Target>();
  const add = (tag: string, source: string, expectCommit: string | null, fromHead: boolean) => {
    const existing = byTag.get(tag);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byTag.set(tag, { tag, sources: [source], expectCommit, fromHead });
  };

  for (const rel of REF_SOURCES) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    const pattern = new RegExp(`${IMAGE_REPO.replace(/[.]/g, "\\.")}:([A-Za-z0-9._-]+)`, "g");
    for (const m of text.matchAll(pattern)) {
      const tag = m[1]!;
      // `:X.Y.Z` and `:sha-` are the table's placeholder rows — the regexp stops
      // at the `<` of `sha-<short>`, so a bare `sha-` is that row, never a tag.
      if (tag === "X.Y.Z" || tag === "sha-") continue;
      const isVersion = /^\d+\.\d+\.\d+$/.test(tag);
      const version = isVersion ? gitOut(["rev-parse", `relay-v${tag}^{commit}`]) : null;
      add(tag, rel, tag === "main" ? head : version, tag === "main");
      // A documented X.Y.Z whose `relay-vX.Y.Z` tag is not visible has no
      // commit to bind to. That is not the same as "bound": the assertion was
      // never formed, and the loop below says so rather than dropping it.
      if (isVersion && version === null) byTag.get(tag)!.unresolvedTag = `relay-v${tag}`;
    }
  }

  // The two tags a push to main publishes, whether or not a doc names them.
  if (head !== null) {
    add(`sha-${head.slice(0, 7)}`, "push to main (publish-images.yml)", head, true);
    add("main", "push to main (publish-images.yml)", head, true);
  }

  // The newest release, whether or not the docs have caught up to it. A
  // release whose image never got published is invisible to a doc-derived
  // target set precisely while it is newest — the window when someone would
  // pull it. Newest ONLY: `relay-v1.0.0` predates publish-images.yml and has
  // no image by construction, and back-filling history is not this gate's job.
  const newestRelease = gitOut(["tag", "--list", "relay-v*", "--sort=-v:refname"])
    ?.split("\n")[0]
    ?.trim();
  if (newestRelease == null || newestRelease === "") {
    // Not a finding — a repo with no release tags is legitimate — but it must
    // be SAID. A shallow checkout carries no tags, and a release target that
    // quietly disappears is a gate narrowing without going red.
    missingReleaseTag = true;
  } else {
    const version = newestRelease.replace(/^relay-v/, "");
    add(
      version,
      `newest release tag (${newestRelease})`,
      gitOut(["rev-parse", `${newestRelease}^{commit}`]),
      false,
    );
  }

  return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

// ── The registry ───────────────────────────────────────────────────────────

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

let pullToken: string | null = null;

/** Anonymous pull token for a public ghcr repository. No credentials needed. */
async function anonymousToken(repository: string): Promise<string | null> {
  if (pullToken !== null) return pullToken;
  try {
    const res = await fetch(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    pullToken = body.token ?? null;
    return pullToken;
  } catch {
    return null;
  }
}

/**
 * The digest a tag currently resolves to, `null` when the tag does not exist,
 * or `undefined` when the registry could not be reached at all. The three cases
 * are different verdicts: absent is a finding, unreachable is not.
 */
async function resolveDigest(tag: string): Promise<string | null | undefined> {
  const repository = IMAGE_REPO.replace("ghcr.io/", "");
  const token = await anonymousToken(repository);
  if (token === null) return undefined;
  try {
    const res = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return res.headers.get("docker-content-digest");
  } catch {
    return undefined;
  }
}

// ── cosign ─────────────────────────────────────────────────────────────────

interface CosignResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Verification results, keyed by (command, DIGEST) rather than by tag.
 *
 * Sigstore verification is a statement about a digest, and `:main` and
 * `sha-<short>` are the same manifest by construction — the ALIAS assertion
 * proves exactly that, so verifying the second reference re-proves nothing at
 * the cost of another transparency-log round-trip (the slow part; a single
 * verification ran over five minutes on a bad day). Which TAG produced a
 * cached verdict is recorded so the output names a reference a reader can
 * re-run by hand.
 */
type Verdict =
  | { status: "verified"; result: CosignResult; viaTag: string }
  | { status: "failed"; detail: string; viaTag: string }
  | { status: "unverified"; detail: string; viaTag: string };

const verified = new Map<string, Verdict>();

/**
 * Turn a cosign run into a verdict. THREE outcomes, not two: a command that
 * could not finish is `unverified`, never `failed`. Collapsing them would
 * report an image as unsigned because Sigstore was slow, which is a false
 * accusation about the artifact rather than an honest statement about the
 * check.
 */
function classify(result: CosignResult, command: VerifyCommand, viaTag: string): Verdict {
  if (result.timedOut) {
    return {
      status: "unverified",
      viaTag,
      detail: `the documented \`cosign ${command.argv[1]}\` command did not complete within ${COSIGN_TIMEOUT_MS / 1000}s, so the image is UNVERIFIED — not proven bad`,
    };
  }
  if (!result.ok) {
    const last = result.stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "no output";
    // Only a message that is ABOUT the artifact earns `failed`. These are the
    // strings cosign prints when the image genuinely does not carry what the
    // documented command demands (observed against the live registry while
    // writing this gate). Anything else — Rekor/Fulcio unreachable, TUF root
    // fetch, DNS, TLS, a registry 5xx, a message this list has never seen —
    // is the CHECK not completing, and blaming the artifact for it is the
    // false accusation the doc comment above promises not to make. The
    // unknown case lands on `unverified`, which in CI is still a finding.
    const artifactFailure = ARTIFACT_FAILURE_MARKERS.some((m) => result.stderr.includes(m));
    if (artifactFailure) {
      return {
        status: "failed",
        viaTag,
        detail: `the documented \`cosign ${command.argv[1]}\` command fails: ${last}`,
      };
    }
    return {
      status: "unverified",
      viaTag,
      detail: `the documented \`cosign ${command.argv[1]}\` command could not complete (${last}) — the image is UNVERIFIED, not proven bad; check Sigstore/ghcr reachability before suspecting the artifact`,
    };
  }
  return { status: "verified", result, viaTag };
}

/**
 * What cosign says when the ARTIFACT fails the documented command, as opposed
 * to the command failing to run. Observed live; extend when a new genuine
 * failure shape appears, never widen to a catch-all.
 */
const ARTIFACT_FAILURE_MARKERS = [
  "no matching signatures",
  "no matching attestations",
  "none of the attestations matched",
  "no signatures found",
  "no matching CertificateIdentity",
  "signature verification failed",
  "invalid signature",
  "image tag not found",
  "MANIFEST_UNKNOWN",
];

function runCosign(command: VerifyCommand, tag: string): CosignResult {
  const argv = [...command.argv];
  argv[command.refIndex] = `${IMAGE_REPO}:${tag}`;
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COSIGN_TIMEOUT_MS,
      // SIGKILL, not the default SIGTERM. `execFileSync` waits for the child to
      // exit, so a process that declines to die on SIGTERM hangs the gate past
      // the job's own timeout — and a job timeout reports as `cancelled`, which
      // is precisely the silent failure this gate was written to catch. The
      // ceiling has to be one the gate can actually enforce.
      killSignal: "SIGKILL",
    });
    return { ok: true, stdout, stderr: "", timedOut: false };
  } catch (err) {
    // execFileSync throws an Error carrying the child's streams; anything else
    // means cosign could not even be spawned, and that message must survive.
    const e = err as { stdout?: unknown; stderr?: unknown; signal?: unknown };
    const message = err instanceof Error ? err.message : String(err);
    const stderr = typeof e.stderr === "string" && e.stderr.length > 0 ? e.stderr : message;
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr,
      timedOut: e.signal === "SIGKILL" || e.signal === "SIGTERM",
    };
  }
}

/** Digests cosign reports it verified a signature over. */
function signedDigests(stdout: string): string[] {
  const digests = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        const digest = (entry as { critical?: { image?: { "docker-manifest-digest"?: string } } })
          .critical?.image?.["docker-manifest-digest"];
        if (typeof digest === "string") digests.add(digest);
      }
    } catch {
      // Not the JSON line — cosign also prints a human-readable preamble.
    }
  }
  return [...digests];
}

interface Provenance {
  subjectDigests: string[];
  gitCommits: string[];
}

/** The in-toto statements cosign prints for a verified attestation. */
function provenance(stdout: string): Provenance {
  const subjectDigests = new Set<string>();
  const gitCommits = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const envelope = JSON.parse(trimmed) as { payload?: string };
      if (typeof envelope.payload !== "string") continue;
      const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf-8")) as {
        subject?: Array<{ digest?: Record<string, string> }>;
        predicate?: {
          buildDefinition?: { resolvedDependencies?: Array<{ digest?: Record<string, string> }> };
        };
      };
      for (const s of statement.subject ?? []) {
        const sha = s.digest?.["sha256"];
        if (sha) subjectDigests.add(`sha256:${sha}`);
      }
      for (const dep of statement.predicate?.buildDefinition?.resolvedDependencies ?? []) {
        const commit = dep.digest?.["gitCommit"];
        if (commit) gitCommits.add(commit);
      }
    } catch {
      // Not an envelope line.
    }
  }
  return { subjectDigests: [...subjectDigests], gitCommits: [...gitCommits] };
}

// ── The publish run ────────────────────────────────────────────────────────

interface PublishRun {
  status: string;
  conclusion: string | null;
  url: string;
}

/**
 * The newest `publish-images` run for a commit, or null when `gh` cannot
 * answer. Read as JSON rather than scraped: a conclusion string is the whole
 * point of the assertion and must not come from column-splitting.
 */
function publishRun(sha: string): PublishRun | null | undefined {
  try {
    const raw = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "publish-images.yml",
        // Filtered server-side by commit. An earlier draft listed the newest
        // 40 runs and filtered here, which made "no run for HEAD" ambiguous
        // between "never published" and "published, but 40 tag pushes ago" —
        // a blind spot that had to be disclosed. Now it is one question.
        "--commit",
        sha,
        "--limit",
        "40",
        "--json",
        "headSha,status,conclusion,url,createdAt",
      ],
      { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
    );
    const runs = JSON.parse(raw) as Array<{
      headSha: string;
      status: string;
      conclusion: string | null;
      url: string;
      createdAt: string;
    }>;
    // A re-run shares the commit; the newest run is the one whose outcome stands.
    const mine = runs
      .filter((r) => r.headSha === sha)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return mine.length > 0
      ? { status: mine[0]!.status, conclusion: mine[0]!.conclusion, url: mine[0]!.url }
      : null;
  } catch {
    return undefined;
  }
}

/**
 * Does `publish-images.yml` run on EVERY push to main? The "no run for HEAD
 * ⇒ the publish path stopped firing" finding below rests on exactly that, and
 * `check-deploy-freshness` (#720) is the record of what happens when a gate
 * assumes a workflow's triggers instead of reading them: it was wrong in both
 * directions for two days. So the premise is read off the file, through the
 * same reader `triggerPaths` there uses — a `paths:` / `paths-ignore:` filter under `push`,
 * or `main` missing from `branches`, and the premise is FALSE and the finding
 * says so instead of accusing the publish path. `null` = the file could not be
 * read, or its `on:` block has a shape the shared reader
 * (`scripts/lib/workflow-triggers.ts`, #731) does not understand.
 */
function publishesEveryMainPush(): boolean | null {
  const trigger = readPushTrigger(join(ROOT, ".github/workflows/publish-images.yml"));
  if (!trigger.readable) return null;
  if (!trigger.push) return false;
  if (trigger.paths !== null || trigger.pathsIgnore !== null) return false;
  if (trigger.branches === null) return null; // "every branch" is not a shape this gate has modelled
  return trigger.branches.includes("main");
}

// ── main ───────────────────────────────────────────────────────────────────

function have(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(
    `▸ check-image-provenance — published images vs ${VERIFY_DOC} (existence + signature + provenance)`,
  );

  if (!have("cosign")) {
    const message =
      "cosign is not installed. This gate verifies the signature and SLSA provenance of every published image by running the commands in docs/operator/self-host.md, which is impossible without it. Fix: install cosign (https://docs.sigstore.dev/cosign/installation/), or in CI use the sigstore/cosign-installer action as .github/workflows/image-provenance.yml does.";
    if (REQUIRE_TOOLS) {
      console.error(`check-image-provenance: ${message}`);
      console.error(
        "A skipped external gate is a dormant one (docs/doctrine/composition-preserves-enforcement.md) — the exact class this gate exists to catch — so a missing prerequisite is RED in CI, never a silent pass.",
      );
      process.exit(1);
    }
    console.log(`  (no cosign — skipping politely. CI runs this with --require-tools.)`);
    return;
  }

  const commands = operatorVerifyCommands();
  const restated = assertCommandParity(commands);
  const head = gitOut(["rev-parse", "HEAD"]);
  const all = targets(head);
  // The publish assertion is about MAIN. A `workflow_dispatch` from a branch
  // (someone trying the gate on its own PR) has no publish run and must not
  // read as the publish path having stopped — the message says "on main", so
  // the code has to know whether it is.
  const branch = process.env["GITHUB_REF_NAME"] ?? gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  const onMain = branch === "main";

  // Whether an image is DUE for HEAD is decided by the publish run, never
  // assumed from the commit. A build still running has not failed; a commit
  // that was never pushed to main (a feature branch, this gate's own PR) was
  // never published at all. Reporting either as a missing image would be a
  // finding about the clock rather than about the registry.
  const run = head === null ? undefined : publishRun(head);
  const buildPending = run == null || run.status !== "completed" || run.conclusion !== "success";

  const findings: Finding[] = [];
  const notes: string[] = [];
  let assertions = 0;

  if (missingReleaseTag) {
    notes.push(
      "no `relay-v*` tag is visible, so the newest release was not checked — a shallow checkout carries no tags (the workflow uses fetch-depth: 0 for this)",
    );
  }

  if (run === undefined) {
    const message =
      head === null
        ? "git could not report HEAD, so which commit's image is due is unknown — the PUBLISHED assertion was not made"
        : `could not read publish-images runs (gh unavailable or unauthenticated) — the PUBLISHED assertion was not made for ${head.slice(0, 7)}`;
    if (REQUIRE_TOOLS) {
      findings.push({ ref: "publish-images", kind: "publish", detail: message });
    } else {
      notes.push(message);
    }
  } else if (run === null) {
    // On the scheduled run HEAD is main's tip. If publish-images.yml runs on
    // every push to main with no path filter — READ from the file, not assumed
    // (#720) — then no run at all means the publish path itself stopped firing:
    // the whole artifact going missing rather than one tag. Locally it just
    // means a feature branch. If the premise no longer holds, the honest
    // finding is that this gate's model of the workflow is stale, not that the
    // publish path broke.
    const everyPush = publishesEveryMainPush();
    const message =
      everyPush === true
        ? `no publish-images run exists for ${head?.slice(0, 7) ?? "HEAD"} — publish-images.yml runs on every push to main, so on main this means the publish path stopped firing`
        : everyPush === false
          ? `no publish-images run exists for ${head?.slice(0, 7) ?? "HEAD"}, and publish-images.yml no longer runs on every push to main (a paths filter, or main absent from branches) — this gate's premise that HEAD's tags are due after every push is STALE; update this gate alongside the workflow`
          : `no publish-images run exists for ${head?.slice(0, 7) ?? "HEAD"}, and the push trigger in publish-images.yml could not be read — whether HEAD's tags are due is unknown, which is not a pass`;
    if (REQUIRE_TOOLS && onMain) {
      assertions++;
      findings.push({ ref: "publish-images", kind: "publish", detail: message });
    } else {
      notes.push(`${message} (on ${branch ?? "an unknown ref"}, not main — expected)`);
    }
  } else if (run.status !== "completed") {
    notes.push(`publish-images for ${head!.slice(0, 7)} is ${run.status} — HEAD tags not yet due`);
  } else {
    assertions++;
    console.log(
      `  ${run.conclusion === "success" ? "✓" : "✗"} publish-images for ${head!.slice(0, 7)} concluded \`${run.conclusion}\``,
    );
    if (run.conclusion !== "success") {
      findings.push({
        ref: "publish-images",
        kind: "publish",
        detail: `the run for ${head!.slice(0, 7)} concluded \`${run.conclusion}\`, not \`success\` (${run.url}). A job TIMEOUT reports as \`cancelled\`, which is why nothing alerted on 2026-09-21`,
      });
    }
  }

  // One registry read per tag; the ALIAS assertion below reasons about the
  // same manifest the loop verified, never a second read that could differ.
  const digests = new Map<string, string | null | undefined>();

  for (const target of all) {
    const ref = `${IMAGE_REPO}:${target.tag}`;
    const where = target.sources.join(", ");

    if (target.fromHead && buildPending) {
      const why =
        run == null
          ? "no publish-images run has completed for this commit"
          : run.status !== "completed"
            ? `the publish run for this commit is still ${run.status}`
            : `the publish run for this commit concluded \`${run.conclusion}\``;
      notes.push(`${ref} — skipped, ${why}`);
      continue;
    }

    const digest = await resolveDigest(target.tag);
    digests.set(target.tag, digest);
    if (digest === undefined) {
      // Not 200 and not 404: the package flipped private (401/403), the token
      // endpoint is down, a 5xx, DNS. The operator cannot pull the image
      // either way. Locally a note; in CI a finding — the same rule as an
      // `unverified` cosign run, because "not assessed" every day is a
      // dormant gate whichever prerequisite went quiet.
      const detail = `the registry did not answer for this tag (neither found nor absent) — existence is UNVERIFIED, which is not a pass; if the package went private, an operator cannot pull it`;
      if (REQUIRE_TOOLS) findings.push({ ref, kind: "unverified", detail });
      else notes.push(`${ref} — ${detail}`);
      continue;
    }
    assertions++;
    if (digest === null) {
      findings.push({
        ref,
        kind: "absent",
        detail: `no such tag in the registry, but ${where} tells an operator to pull it`,
      });
      continue;
    }

    const before = findings.length;
    const proven: string[] = [];

    for (const command of commands) {
      assertions++;
      const key = command.kind + ":" + digest;
      const existing = verified.get(key);
      const shared = existing !== undefined && existing.viaTag !== target.tag;
      const verdict = existing ?? classify(runCosign(command, target.tag), command, target.tag);
      if (existing === undefined) verified.set(key, verdict);
      const via = shared ? ` (through ${IMAGE_REPO}:${verdict.viaTag}, the identical digest)` : "";

      if (verdict.status === "unverified") {
        // A verification that cannot complete is not evidence of a good image,
        // and it is not evidence of a bad one either. Locally that is a network
        // note; in CI it is a finding, because a gate that quietly reports "not
        // assessed" every day is a dormant gate — the failing-silently shape
        // this gate exists to catch.
        if (REQUIRE_TOOLS) findings.push({ ref, kind: "unverified", detail: verdict.detail + via });
        else {
          assertions--;
          notes.push(`${ref} — ${verdict.detail}${via}`);
        }
        continue;
      }

      if (verdict.status === "failed") {
        findings.push({
          ref,
          kind: command.kind === "signature" ? "unsigned" : "unattested",
          detail: verdict.detail + via,
        });
        continue;
      }

      // Verification passing is not enough — what it verified must be what the
      // tag serves NOW. cosign resolves the reference itself, so a tag that
      // moved between the registry read and the verification shows up here.
      if (command.kind === "signature") {
        const signed = signedDigests(verdict.result.stdout);
        // cosign exiting 0 with output this gate cannot read is not "signed":
        // the digest binding was never checked. A cosign that changes its
        // JSON, or a doc edit that adds `--output text` to the command this
        // gate runs verbatim, must go red here, not print a tick.
        if (signed.length === 0) {
          findings.push({
            ref,
            kind: "unverified",
            detail: `cosign verify exited 0 but its output carried no manifest digest this gate recognizes, so the signature was not bound to what the tag serves${via}`,
          });
          continue;
        }
        if (!signed.includes(digest)) {
          findings.push({
            ref,
            kind: "mismatch",
            detail: `signature covers ${signed.join(", ")} but the tag resolves to ${digest}`,
          });
          continue;
        }
        proven.push(`signed${via}`);
        continue;
      }

      const { subjectDigests, gitCommits } = provenance(verdict.result.stdout);
      assertions++;
      let bound = true;
      if (subjectDigests.length === 0) {
        findings.push({
          ref,
          kind: "unverified",
          detail: `cosign verify-attestation exited 0 but no in-toto subject digest could be read from its output, so the provenance was not bound to what the tag serves${via}`,
        });
        continue;
      }
      if (!subjectDigests.includes(digest)) {
        bound = false;
        findings.push({
          ref,
          kind: "mismatch",
          detail: `provenance subject is ${subjectDigests.join(", ")} but the tag resolves to ${digest}`,
        });
      }
      if (target.unresolvedTag !== undefined) {
        // The docs name a version whose tag this checkout cannot see. With
        // fetch-depth: 0 in CI that means the docs are ahead of the tag (or
        // the tag was never pushed), and the commit binding CANNOT be checked
        // — said, never silently skipped.
        const detail = `commit binding not checked: ${target.unresolvedTag} is not a visible git tag, so which commit this image should be built from is unknown`;
        if (REQUIRE_TOOLS) {
          bound = false;
          findings.push({ ref, kind: "unverified", detail });
        } else notes.push(`${ref} — ${detail} (a shallow checkout carries no tags)`);
      } else if (target.expectCommit !== null && gitCommits.length === 0) {
        // The provenance carries no gitCommit at all. The build always emits
        // one; a statement without it is a shape this gate does not know.
        bound = false;
        findings.push({
          ref,
          kind: "unverified",
          detail: `provenance carries no gitCommit, so whether this image was built from ${target.expectCommit.slice(0, 7)} could not be checked${via}`,
        });
      } else if (target.expectCommit !== null) {
        assertions++;
        if (!gitCommits.includes(target.expectCommit)) {
          bound = false;
          findings.push({
            ref,
            kind: "mismatch",
            detail: `provenance attests source commit ${gitCommits.join(", ")}, but this tag should be built from ${target.expectCommit}`,
          });
        }
      }
      if (bound) {
        proven.push(
          `attested to ${gitCommits.length > 0 ? gitCommits.map((c) => c.slice(0, 7)).join("/") : "an unnamed commit"}${via}`,
        );
      }
    }

    // Say what was actually proven, never a fixed "signed, attested" caption: a
    // line that reads the same whether or not the verification ran is how a
    // green check stops meaning anything.
    if (findings.length === before) {
      // `✓` only when something was actually proven. A tick beside "nothing
      // verified" is the kind of line a reader skims as success.
      console.log(
        `  ${proven.length > 0 ? "✓" : "–"} ${ref} — ${digest.slice(0, 19)}… ${proven.length > 0 ? proven.join(", ") : "resolves, but nothing about it was verified"} (named in ${where})`,
      );
    } else {
      console.log(`  ✗ ${ref} — ${digest.slice(0, 19)}… see finding(s) below (named in ${where})`);
    }
  }

  // ALIAS: #723's invariant, read off the registry rather than the workflow.
  if (head !== null && !buildPending) {
    const shaTag = `sha-${head.slice(0, 7)}`;
    const aliasDigest = digests.has("main") ? digests.get("main") : await resolveDigest("main");
    const shaDigest = digests.has(shaTag) ? digests.get(shaTag) : await resolveDigest(shaTag);
    if (aliasDigest === undefined || shaDigest === undefined) {
      const detail = `the registry did not answer for :main or ${shaTag}, so #723's alias invariant (both tags = one digest) was not checked`;
      if (REQUIRE_TOOLS) findings.push({ ref: `${IMAGE_REPO}:main`, kind: "unverified", detail });
      else notes.push(detail);
    } else if (typeof aliasDigest === "string" && typeof shaDigest === "string") {
      assertions++;
      if (aliasDigest !== shaDigest) {
        findings.push({
          ref: `${IMAGE_REPO}:main`,
          kind: "mismatch",
          detail: `points at ${aliasDigest} but ${shaTag} (main HEAD) is ${shaDigest} — the floating tag is not this commit`,
        });
      }
    }
  }

  for (const note of notes) console.log(`  – ${note}`);

  if (findings.length > 0) {
    failWithRepair({
      invariant: `check-image-provenance: ${findings.length} finding(s) against the images ${VERIFY_DOC} tells an operator to pull`,
      sites: findings.map((f) => `[${f.kind}] ${f.ref}: ${f.detail}`),
      canonical: `.github/workflows/publish-images.yml (what publishes) and ${VERIFY_DOC} (what operators are told to run)`,
      fix: "For [absent] or [publish] — open the publish-images run for this commit and re-run it; a job TIMEOUT reports as `cancelled`, so check the duration against `timeout-minutes` before assuming someone intervened. For [unsigned] or [unattested] — run the failing command yourself against that tag: if the image is genuinely unsigned, re-run the publish job (signing is keyless and idempotent); if the image is fine and the COMMAND is wrong, fix it in docs/operator/self-host.md, because that is the command an operator runs. For [unverified] — nothing is known about that image either way; re-run this workflow, and if it recurs check Sigstore/ghcr availability before suspecting the image. For [mismatch] — the tag moved to a digest that was never signed or was built from another commit; do not re-tag, re-run the publish so the alias is applied to a signed digest (the ordering #723 established).",
      doctrine:
        "docs/doctrine/self-attesting-system.md — every claim is user-verifiable; an unsigned image under a documented tag fails OPEN, because nothing about it says the guarantee is missing.",
    });
  }

  console.log(
    `✓ check-image-provenance: ${all.length} documented tag(s) of ${IMAGE_REPO} checked, ` +
      `${assertions} assertion(s) made${notes.length > 0 ? `, ${notes.length} not assessed` : ""}.\n` +
      `  Aperture: tags are read from ${REF_SOURCES.length} operator-facing file(s) (${REF_SOURCES.join(", ")}) ` +
      `plus the two every push to main publishes; the ${commands.length} cosign command(s) are parsed from ` +
      `${VERIFY_DOC} rather than written here, with ${restated} restatement(s) of them elsewhere held to that shape; verification runs once per DIGEST, so tags sharing a manifest are verified through one of them. Blind to a tag no document names, to any repository other than ` +
      `${IMAGE_REPO}, to the image's CONTENTS (a signed image is proven to be ours, never proven good), and to ` +
      `a publish run GitHub no longer retains (the run is looked up by HEAD's commit, so nothing falls out of a listing window). ` +
      `Whether HEAD's tags are DUE is read from publish-images.yml's push trigger, never assumed.`,
  );
}

void main();
