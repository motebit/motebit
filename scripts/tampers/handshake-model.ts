/**
 * Peering handshake model-check tamper checks (relay-federation@1.5 §3.1,
 * §3.3, §3.5) — each structural guard, removed, must turn the model harness
 * (`services/relay/src/__tests__/federation-handshake-model.test.ts`) red.
 *
 * Every entry is (text the fix added, what to put back, the vitest name
 * filter that must go red). The runner applies one tamper at a time, runs the
 * harness, expects a FAILURE, and restores the file. An entry whose text is
 * not found is a failure of this script.
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

interface Tamper {
  name: string;
  find: string;
  replace: string;
  /** vitest `-t` filter (default: the whole file). */
  filter?: string;
}

const TAMPERS: Tamper[] = [
  {
    name: "R2: the confirm body no longer commits to the recipient's key (mint and verify agree, so honest peering still works)",
    find: "    recipient_public_key: recipientPublicKey.toLowerCase(),\n",
    replace: "",
    filter: "R2",
  },
  {
    name: "R1: a never-confirmed row pins its key at propose (the key pin applied to any row)",
    find: "const peer = existing?.peered_at != null ? existing : undefined;\n    // A confirmed peer's re-handshake",
    replace: "const peer = existing;\n    // A confirmed peer's re-handshake",
    filter: "start removed-unconfirmed",
  },
  {
    name: "R1': a never-confirmed pending row holds the relay_id first-come (409 to every later propose)",
    find: "const peer = existing?.peered_at != null ? existing : undefined;\n    // A confirmed peer's re-handshake",
    replace:
      'if (existing?.peered_at == null && existing?.state === "pending")\n      throw new HTTPException(409, { message: "Peer already exists in pending state" });\n    const peer = existing?.peered_at != null ? existing : undefined;\n    // A confirmed peer\'s re-handshake',
    filter: "start pending-unconfirmed",
  },
  {
    name: "§3.3: a removal naming a never-confirmed row is no longer refused as an unknown peer",
    find: 'if (!peer || peer.peered_at == null)\n      throw new HTTPException(403, { message: "Removal refused: unknown peer" });',
    replace:
      'if (!peer)\n      throw new HTTPException(403, { message: "Removal refused: unknown peer" });',
    filter: "no peer",
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

let failures = 0;
const abs = path.join(ROOT, FILE);
for (const t of TAMPERS) {
  const original = readFileSync(abs, "utf8");
  if (!original.includes(t.find)) {
    console.error(`STALE  ${t.name}: text not found in ${FILE}`);
    failures++;
    continue;
  }
  writeFileSync(abs, original.replace(t.find, t.replace));
  try {
    if (passes(HARNESS, t.filter)) {
      console.error(`GREEN  ${t.name}: ${HARNESS} still passes with the guard removed`);
      failures++;
    } else {
      console.log(`red    ${t.name}`);
    }
  } finally {
    writeFileSync(abs, original);
  }
}
if (failures > 0) {
  console.error(`${failures} tamper(s) did not turn the harness red`);
  process.exit(1);
}
console.log(`all ${TAMPERS.length} tampers turned the harness red`);
