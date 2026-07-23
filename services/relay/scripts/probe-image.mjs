#!/usr/bin/env node
/**
 * Deployed-behavior security-boundary probe for the SHIPPED relay container —
 * the container-image rung of the booted-artifact tier
 * (docs/doctrine/composition-preserves-enforcement.md).
 *
 * The two rungs below this one (booted-entry-activation.test.ts) boot the
 * source entry and the compiled `dist/server.js`; this rung boots the actual
 * image `publish-images.yml` ships — the `pnpm deploy`-flattened filesystem,
 * the pinned base-image node, `run.sh` itself — and observes the boundary
 * from outside over real HTTP.
 *
 * It is designed to run INSIDE the image under test: a sibling container
 * sharing the relay container's network namespace imports the image's OWN
 * compiled `probeSecurityBoundaries` (default `/app/dist/relay-config.js`)
 * and drives it against the booted relay. The probe bytes are the artifact's
 * bytes — nothing is rebuilt or re-resolved from source, so a probe-green
 * can only come from the shipped code enforcing the boundary.
 *
 * Usage: node probe-image.mjs <baseUrl>
 *   PROBE_MODULE  override the probe module path (default /app/dist/relay-config.js)
 *
 * Exit codes: 0 all applicable boundaries strict; 1 boundary lost or probe
 * could not establish a non-vacuous observation; 2 usage error.
 */

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("usage: node probe-image.mjs <baseUrl>");
  process.exit(2);
}
const modulePath = process.env.PROBE_MODULE ?? "/app/dist/relay-config.js";

const BOOT_DEADLINE_MS = 60_000;

/** A red result must teach its own repair (gate-repair-instructions doctrine). */
function failWithRepair(lines) {
  for (const line of lines) console.error(line);
  console.error(
    "\nFix: the boundary registry is `probeSecurityBoundaries` in " +
      "services/relay/src/relay-config.ts; a non-strict observation from the " +
      "SHIPPED image means the deployed composition lost a security default " +
      "between source and container — the #359 class at the image tier. " +
      "Diff the image's /app/dist against a fresh `pnpm --filter " +
      "@motebit/relay build`, and check the Dockerfile env for overrides. " +
      "Doctrine: docs/doctrine/composition-preserves-enforcement.md.",
  );
  process.exit(1);
}

const { probeSecurityBoundaries } = await import(modulePath);

// Boot-wait: the relay container starts concurrently; poll until it answers.
const deadline = Date.now() + BOOT_DEADLINE_MS;
let up = false;
let lastErr = "";
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (res.ok) {
      up = true;
      break;
    }
    lastErr = `GET /health → ${res.status}`;
  } catch (err) {
    lastErr = err instanceof Error ? err.message : String(err);
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  failWithRepair([
    `relay image did not answer GET ${baseUrl}/health within ${BOOT_DEADLINE_MS}ms`,
    `last error: ${lastErr}`,
  ]);
}

const results = await probeSecurityBoundaries(baseUrl, { federationEnabled: true });
const probed = results.filter((r) => !r.skipped);

// Vacuous-pass guards: at least one boundary must actually be observed, and
// the #359 boundary (unsigned federation discover) specifically must be
// probed, not skipped.
if (probed.length === 0) {
  failWithRepair(["probe observed ZERO applicable boundaries — a vacuous pass, treated as red"]);
}
const discover = results.find((r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE");
if (!discover || discover.skipped) {
  failWithRepair([
    "the #359 boundary (unsigned federation discover) was not observed — " +
      "is MOTEBIT_FEDERATION_ENDPOINT_URL set on the relay container?",
  ]);
}

const lost = probed.filter((r) => !r.strict);
if (lost.length > 0) {
  failWithRepair(
    lost.map((r) => `LOST: ${r.boundary} (${r.envVar}): ${r.detail}`),
  );
}

for (const r of probed) {
  console.log(`strict: ${r.boundary} (${r.envVar})`);
}
console.log(`\nall ${probed.length} applicable security boundaries strict on the shipped image`);
