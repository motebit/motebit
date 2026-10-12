/**
 * Peering handshake model-check tamper checks (relay-federation@1.5 §3.1,
 * §3.3, §3.5) — each structural guard, removed, must turn the model harness
 * (`services/relay/src/__tests__/federation-handshake-model.test.ts`) red.
 *
 * Every entry is (edits — text the fix added and what to put back, in one or
 * more files; the vitest name filter that must go red; a package to rebuild
 * when the edit is in a library the relay reads from dist). The runner
 * applies one tamper at a time, runs the harness, expects a FAILURE, and
 * restores (and rebuilds). An entry whose text is not found is a failure of
 * this script.
 *
 *   npx tsx scripts/tampers/handshake-model.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = "services/relay/src/federation.ts";
const PKG = "services/relay";
const HARNESS = "src/__tests__/federation-handshake-model.test.ts";

interface Edit {
  file: string;
  find: string;
  replace: string;
}

interface Tamper {
  name: string;
  edits: Edit[];
  /** vitest `-t` filter (default: the whole file). */
  filter?: string;
  /** A workspace package to rebuild with the tamper in place (the relay reads its dist). */
  build?: string;
}

const CRYPTO_VERIFIER = "packages/crypto/src/federation-message.ts";

const TAMPERS: Tamper[] = [
  {
    name: "round 3 (R2, F1', F2): the envelope's recipient key is never compared — not by the verifier, not by the routes",
    edits: [
      {
        file: CRYPTO_VERIFIER,
        find: '  if (envelope.recipient_public_key !== expect.selfPublicKeyHex.toLowerCase())\n    return { ok: false, reason: "wrong_recipient_key" };\n',
        replace: "",
      },
      {
        file: FILE,
        find: "    env.recipient_public_key !== self.publicKeyHex.toLowerCase()\n",
        replace: "    false\n",
      },
    ],
    filter: "R2|F1'|F2",
    build: "@motebit/crypto",
  },
  {
    name: "R1: a never-confirmed row pins its key at propose (the key pin applied to any row)",
    edits: [
      {
        file: FILE,
        find: "const peer = existing?.peered_at != null ? existing : undefined;\n    // A propose writes nothing",
        replace: "const peer = existing;\n    // A propose writes nothing",
      },
    ],
    filter: "start removed-unconfirmed",
  },
  {
    name: "R1': a never-confirmed pending row holds the relay_id first-come (409 to every later propose)",
    edits: [
      {
        file: FILE,
        find: "const peer = existing?.peered_at != null ? existing : undefined;\n    // A propose writes nothing",
        replace:
          'if (existing?.peered_at == null && existing?.state === "pending")\n      throw new HTTPException(409, { message: "Peer already exists in pending state" });\n    const peer = existing?.peered_at != null ? existing : undefined;\n    // A propose writes nothing',
      },
    ],
    filter: "start pending-unconfirmed",
  },
  {
    name: "§3.3: a removal naming a never-confirmed row is no longer refused as an unknown peer",
    edits: [
      {
        file: FILE,
        find: 'if (!peer || peer.peered_at == null)\n      throw new HTTPException(403, { message: "Removal refused: unknown peer" });',
        replace:
          'if (!peer)\n      throw new HTTPException(403, { message: "Removal refused: unknown peer" });',
      },
    ],
    filter: "no peer",
  },
  {
    name: "F4: a propose spends the named relay_id's per-peer slot again",
    edits: [
      {
        file: FILE,
        find: "    checkMaxPeers();\n\n    // A known peer's key is never replaced",
        replace:
          "    checkPeerLimit(relay_id);\n    checkMaxPeers();\n\n    // A known peer's key is never replaced",
      },
    ],
    filter: "F4",
  },
];

function passes(test: string, filter: string | undefined): boolean {
  try {
    execFileSync("npx", ["vitest", "run", test, ...(filter ? ["-t", filter] : [])], {
      cwd: path.join(ROOT, PKG),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function build(pkg: string | undefined): void {
  if (pkg === undefined) return;
  execFileSync("pnpm", ["--filter", pkg, "build"], { cwd: ROOT, stdio: "ignore" });
}

let failures = 0;
for (const t of TAMPERS) {
  const originals = new Map<string, string>();
  for (const e of t.edits) {
    const abs = path.join(ROOT, e.file);
    if (!originals.has(abs)) originals.set(abs, readFileSync(abs, "utf8"));
  }
  const stale = t.edits.find(
    (e) => !readFileSync(path.join(ROOT, e.file), "utf8").includes(e.find),
  );
  if (stale !== undefined) {
    console.error(`STALE  ${t.name}: text not found in ${stale.file}`);
    failures++;
    continue;
  }
  for (const e of t.edits) {
    const abs = path.join(ROOT, e.file);
    writeFileSync(abs, readFileSync(abs, "utf8").replace(e.find, e.replace));
  }
  try {
    build(t.build);
    if (passes(HARNESS, t.filter)) {
      console.error(`GREEN  ${t.name}: ${HARNESS} still passes with the guard removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    for (const [abs, text] of originals) writeFileSync(abs, text);
    build(t.build);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn the harness red`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned the harness red`);
