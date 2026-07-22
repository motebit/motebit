#!/usr/bin/env tsx
/**
 * check-routing-transcript-emission — the routing-decision transcript's
 * producer + egress chain stays structural
 * (docs/doctrine/routing-decision-transcript.md Inc 4).
 *
 * A transcript that CAN be emitted drifts into one that sometimes isn't:
 * a refactor of the WorkerSelector seam could quietly drop the mint, a
 * result-shape edit could drop the egress field, and the conformance
 * probe's assertion would go silently vacuous (verify-if-present passes
 * on absent-forever). This gate holds the four links of the chain by
 * source inspection:
 *
 *   1. PRODUCER — the runtime's granted-delegation seam ranks via the
 *      produced-basis emitter (`rankWorkersWithBasis`) and signs the basis
 *      (`signRoutingTranscript`); a bare `selectWorker` at the seam is the
 *      drift that silently stops minting.
 *   2. RESULT EGRESS — `GrantedDelegationResult` carries the
 *      `routingTranscript` field a molecule self-attests from.
 *   3. RECEIPT EMBED — the research molecule (the reference composition)
 *      embeds `routing_transcripts` into its signed receipt payload.
 *   4. PROOF CONTRACT — the conformance probe verifies both rungs
 *      (`verifyRoutingTranscript` + `recomputeRoutingDecision`).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const CHAIN: Array<{ file: string; needle: string; link: string }> = [
  {
    file: "packages/runtime/src/motebit-runtime.ts",
    needle: "rankWorkersWithBasis(",
    link: "producer ranks via the produced-basis emitter",
  },
  {
    file: "packages/runtime/src/motebit-runtime.ts",
    needle: "signRoutingTranscript(",
    link: "producer signs the frozen basis",
  },
  {
    file: "packages/runtime/src/motebit-runtime.ts",
    needle: "mintedTranscript = transcript",
    link: "producer threads the minted transcript onto the delegation result (the buffer alone is not egress)",
  },
  {
    file: "packages/molecule-runner/src/index.ts",
    needle: "signingKeys: { privateKey: identity.privateKey",
    link: "money molecules wire delegator signing keys (else the producer is silently dormant in every deployed molecule)",
  },
  {
    file: "packages/runtime/src/relay-delegation.ts",
    needle: "routingTranscript?:",
    link: "GrantedDelegationResult carries the egress field",
  },
  {
    file: "services/research/src/index.ts",
    needle: "routing_transcripts: r.routing_transcripts",
    link: "research embeds transcripts into its signed receipt payload",
  },
  {
    file: "scripts/archetype-conformance.ts",
    needle: "verifyRoutingTranscript(",
    link: "conformance probe verifies the integrity rung",
  },
  {
    file: "scripts/archetype-conformance.ts",
    needle: "recomputeRoutingDecision(",
    link: "conformance probe verifies the faithfulness rung",
  },
];

const broken = CHAIN.filter((c) => {
  try {
    return !read(c.file).includes(c.needle);
  } catch {
    return true;
  }
});

if (broken.length > 0) {
  failWithRepair({
    invariant:
      "check-routing-transcript-emission: every ranked paid hire mints a signed routing-decision transcript that egresses to the molecule's receipt and is verified by the conformance probe — a hire you can prove, not just replay.",
    canonical:
      "docs/doctrine/routing-decision-transcript.md (Inc 3 producer + Inc 4 proof contract); spec/routing-transcript-v1.md §5",
    fix: "Restore the missing chain link(s): packages/runtime/src/motebit-runtime.ts must rank via rankWorkersWithBasis and sign via signRoutingTranscript at the WorkerSelector seam; packages/runtime/src/relay-delegation.ts GrantedDelegationResult must carry routingTranscript; services/research/src/index.ts must embed routing_transcripts in its receipt payload; scripts/archetype-conformance.ts must verify both rungs (verifyRoutingTranscript + recomputeRoutingDecision).",
    sites: broken.map((c) => `${c.file}: missing "${c.needle}" (${c.link})`),
    doctrine: "docs/doctrine/routing-decision-transcript.md",
  });
}

console.log(
  `✓ check-routing-transcript-emission: all ${CHAIN.length} links of the transcript chain (producer → signing keys → result egress → receipt embed → both-rung proof) are present.`,
);
