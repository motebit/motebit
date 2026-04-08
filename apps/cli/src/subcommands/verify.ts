/**
 * `motebit verify <path>` — verify identity files, export bundles,
 * individual Verifiable Credentials, or Verifiable Presentations.
 *
 * Extracted from `subcommands.ts` as Target 8 of the CLI extraction —
 * the largest target at ~400 lines, including six private helper
 * functions (tryParseJson, readJsonFile, isVerifiableCredential,
 * isVerifiablePresentation, credentialTypeName, extractSubjectMotebitId)
 * that travel with the module because nothing else uses them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { verifyIdentityFile } from "@motebit/identity-file";
import { verifyVerifiableCredential, verifyVerifiablePresentation } from "@motebit/crypto";
import type { VerifiableCredential, VerifiablePresentation } from "@motebit/crypto";

/** Try to parse JSON from a string, returning null on failure. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read a JSON file from disk, returning { ok, data } or { ok: false, error }. */
function readJsonFile(
  filePath: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { ok: false, error: "file not found" };
  }
  const parsed = tryParseJson(raw);
  if (parsed == null) {
    return { ok: false, error: "invalid JSON" };
  }
  return { ok: true, data: parsed };
}

/** Check if a parsed object looks like a VerifiableCredential. */
function isVerifiableCredential(obj: unknown): obj is VerifiableCredential {
  if (typeof obj !== "object" || obj == null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    Array.isArray(rec["type"]) &&
    (rec["type"] as unknown[]).includes("VerifiableCredential") &&
    rec["proof"] != null &&
    rec["credentialSubject"] != null
  );
}

/** Check if a parsed object looks like a VerifiablePresentation. */
function isVerifiablePresentation(obj: unknown): obj is VerifiablePresentation {
  if (typeof obj !== "object" || obj == null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    Array.isArray(rec["type"]) &&
    (rec["type"] as unknown[]).includes("VerifiablePresentation") &&
    rec["proof"] != null &&
    Array.isArray(rec["verifiableCredential"])
  );
}

/** Get the human-readable credential type (last type in the array that isn't "VerifiableCredential"). */
function credentialTypeName(vc: VerifiableCredential): string {
  const types = vc.type.filter((t) => t !== "VerifiableCredential");
  return types.length > 0 ? types[types.length - 1]! : "VerifiableCredential";
}

/** Extract the motebit_id from a credential subject's id (strip did:key: prefix to get raw id, or use motebit_id field). */
function extractSubjectMotebitId(vc: VerifiableCredential): string | null {
  const subject = vc.credentialSubject;
  // Check for explicit motebit_id field
  const subjectRec = subject as Record<string, unknown>;
  if (typeof subjectRec["motebit_id"] === "string") {
    return subjectRec["motebit_id"];
  }
  // The subject id is typically a did:key — return as-is for cross-checking
  return typeof subject.id === "string" ? subject.id : null;
}

export async function handleVerify(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    console.error(`Error: path does not exist: ${resolved}`);
    process.exit(1);
  }

  // --- Single file ---
  if (stat.isFile()) {
    if (resolved.endsWith(".md")) {
      await verifySingleIdentityFile(resolved);
    } else if (resolved.endsWith(".json")) {
      await verifySingleJsonFile(resolved);
    } else {
      console.error(`Error: unsupported file type. Expected .md or .json`);
      process.exit(1);
    }
    return;
  }

  // --- Directory (export bundle) ---
  if (!stat.isDirectory()) {
    console.error(`Error: path is not a file or directory: ${resolved}`);
    process.exit(1);
  }

  await verifyBundle(resolved);
}

async function verifySingleIdentityFile(filePath: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    console.error(`Error: cannot read file: ${filePath}`);
    process.exit(1);
  }

  const result = await verifyIdentityFile(content);
  if (result.valid && result.identity) {
    const pubKey = result.identity.identity.public_key;
    const fingerprint = pubKey.slice(0, 16) + "...";
    console.log(`Identity:    ${result.identity.motebit_id}`);
    if (result.did) console.log(`DID:         ${result.did}`);
    console.log(`Public key:  ${fingerprint}`);
    console.log(`Signature:   valid`);
    process.exit(0);
  } else {
    console.error(`Signature:   invalid`);
    if (result.error != null && result.error !== "") {
      console.error(`Error:       ${result.error}`);
    }
    process.exit(1);
  }
}

async function verifySingleJsonFile(filePath: string): Promise<void> {
  const jsonResult = readJsonFile(filePath);
  if (!jsonResult.ok) {
    console.error(`Error: ${jsonResult.error}`);
    process.exit(1);
  }

  const data = jsonResult.data;

  // Try as VerifiablePresentation first (it's also an object with "type" array)
  if (isVerifiablePresentation(data)) {
    console.log(`\nVerifying presentation...\n`);
    const vpResult = await verifyVerifiablePresentation(data);
    const credCount = data.verifiableCredential.length;
    if (vpResult.valid) {
      console.log(
        `  Presentation:  valid — ${credCount} credential${credCount !== 1 ? "s" : ""}, holder: ${data.holder}`,
      );
    } else {
      console.error(`  Presentation:  INVALID`);
      for (const err of vpResult.errors) {
        console.error(`    - ${err}`);
      }
    }
    console.log();
    process.exit(vpResult.valid ? 0 : 1);
  }

  // Try as single VerifiableCredential
  if (isVerifiableCredential(data)) {
    console.log(`\nVerifying credential...\n`);
    const valid = await verifyVerifiableCredential(data);
    const typeName = credentialTypeName(data);
    if (valid) {
      console.log(`  ${typeName}:  valid — issuer: ${data.issuer}`);
    } else {
      console.error(`  ${typeName}:  INVALID`);
    }
    console.log();
    process.exit(valid ? 0 : 1);
  }

  // Try as array of VCs
  if (Array.isArray(data) && data.length > 0 && isVerifiableCredential(data[0])) {
    console.log(`\nVerifying ${data.length} credential${data.length !== 1 ? "s" : ""}...\n`);
    let allValid = true;
    for (const item of data) {
      if (!isVerifiableCredential(item)) {
        console.error(`  (unknown entry):  skipped — not a VerifiableCredential`);
        allValid = false;
        continue;
      }
      const valid = await verifyVerifiableCredential(item);
      const typeName = credentialTypeName(item);
      if (valid) {
        console.log(`  ${typeName}:  valid — issuer: ${item.issuer}`);
      } else {
        console.error(`  ${typeName}:  INVALID`);
        allValid = false;
      }
    }
    console.log();
    process.exit(allValid ? 0 : 1);
  }

  console.error(
    `Error: JSON file is not a recognized VerifiableCredential, VerifiablePresentation, or credential array.`,
  );
  process.exit(1);
}

async function verifyBundle(dirPath: string): Promise<void> {
  console.log(`\nVerifying ${path.basename(dirPath)}/...\n`);

  let passed = true;
  let motebitId: string | null = null;
  let identityDid: string | null = null;

  // 1. Identity (motebit.md)
  const identityPath = path.join(dirPath, "motebit.md");
  if (fs.existsSync(identityPath)) {
    let content: string;
    try {
      content = fs.readFileSync(identityPath, "utf-8");
    } catch {
      console.log(`  Identity (motebit.md):     FAILED — cannot read file`);
      passed = false;
      content = "";
    }
    if (content !== "") {
      const result = await verifyIdentityFile(content);
      if (result.valid && result.identity) {
        motebitId = result.identity.motebit_id;
        identityDid = result.did ?? null;
        const idShort = motebitId.length > 12 ? motebitId.slice(0, 12) + "..." : motebitId;
        console.log(`  Identity (motebit.md):     valid — motebit_id: ${idShort}`);
      } else {
        console.log(
          `  Identity (motebit.md):     INVALID — ${result.error ?? "signature verification failed"}`,
        );
        passed = false;
      }
    }
  } else {
    console.log(`  Identity (motebit.md):     not found, skipping`);
  }

  // 2. Credentials (credentials.json)
  const credsPath = path.join(dirPath, "credentials.json");
  const credentials: VerifiableCredential[] = [];
  if (fs.existsSync(credsPath)) {
    const credResult = readJsonFile(credsPath);
    if (!credResult.ok) {
      console.log(`  Credentials:               FAILED — ${credResult.error}`);
      passed = false;
    } else {
      const data = credResult.data;
      const credArray = Array.isArray(data) ? data : [];
      if (credArray.length === 0) {
        console.log(`  Credentials:               empty (0 found)`);
      } else {
        let validCount = 0;
        const credLines: string[] = [];
        for (const item of credArray) {
          if (!isVerifiableCredential(item)) {
            credLines.push(`    - (unrecognized entry)     INVALID — not a VerifiableCredential`);
            passed = false;
            continue;
          }
          credentials.push(item);
          const valid = await verifyVerifiableCredential(item);
          const typeName = credentialTypeName(item).padEnd(32);
          if (valid) {
            validCount++;
            const issuerShort =
              item.issuer.length > 20 ? item.issuer.slice(0, 20) + "..." : item.issuer;
            credLines.push(`    - ${typeName} valid — issuer: ${issuerShort}`);
          } else {
            credLines.push(`    - ${typeName} INVALID`);
            passed = false;
          }
        }
        const statusIcon = validCount === credArray.length ? "valid" : "FAILED";
        console.log(
          `  Credentials (${credArray.length} found):     ${statusIcon} — ${validCount}/${credArray.length} valid`,
        );
        for (const line of credLines) {
          console.log(line);
        }
      }
    }
  } else {
    console.log(`  Credentials:               not found, skipping`);
  }

  // 3. Presentation (presentation.json)
  const vpPath = path.join(dirPath, "presentation.json");
  if (fs.existsSync(vpPath)) {
    const vpResult = readJsonFile(vpPath);
    if (!vpResult.ok) {
      console.log(`  Presentation:              FAILED — ${vpResult.error}`);
      passed = false;
    } else if (!isVerifiablePresentation(vpResult.data)) {
      console.log(`  Presentation:              FAILED — not a valid VerifiablePresentation`);
      passed = false;
    } else {
      const vp = vpResult.data;
      const result = await verifyVerifiablePresentation(vp);
      const credCount = vp.verifiableCredential.length;
      if (result.valid) {
        const holderShort = vp.holder.length > 20 ? vp.holder.slice(0, 20) + "..." : vp.holder;
        console.log(
          `  Presentation:              valid — ${credCount} credential${credCount !== 1 ? "s" : ""}, holder: ${holderShort}`,
        );
      } else {
        console.log(`  Presentation:              INVALID`);
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
        passed = false;
      }
    }
  } else {
    console.log(`  Presentation:              not found, skipping`);
  }

  // 4. Subject consistency — cross-check credential subjects against motebit_id
  if (motebitId != null && credentials.length > 0) {
    // Build the expected DID for this motebit — credentials may reference the did:key
    let allConsistent = true;
    for (const vc of credentials) {
      const subjectId = extractSubjectMotebitId(vc);
      if (subjectId == null) continue;
      // The subject id should be either the motebit_id directly or the did:key derived from the identity
      const matches = subjectId === motebitId || (identityDid != null && subjectId === identityDid);
      if (!matches) {
        allConsistent = false;
        break;
      }
    }
    if (allConsistent) {
      const idShort = motebitId.length > 12 ? motebitId.slice(0, 12) + "..." : motebitId;
      console.log(`  Subject consistency:       valid — all credentials reference ${idShort}`);
    } else {
      console.log(
        `  Subject consistency:       FAILED — credential subjects do not match identity`,
      );
      passed = false;
    }
  }

  // 5. Budget (budget.json) — informational, no cryptographic verification
  const budgetPath = path.join(dirPath, "budget.json");
  if (fs.existsSync(budgetPath)) {
    const budgetResult = readJsonFile(budgetPath);
    if (!budgetResult.ok) {
      console.log(`  Budget:                    FAILED — ${budgetResult.error}`);
    } else {
      const budgetData = budgetResult.data as Record<string, unknown>;
      const allocations = Array.isArray(budgetData["allocations"]) ? budgetData["allocations"] : [];
      const settlements = Array.isArray(budgetData["settlements"]) ? budgetData["settlements"] : [];
      const parts: string[] = [];
      if (allocations.length > 0) {
        parts.push(`${allocations.length} allocation${allocations.length !== 1 ? "s" : ""}`);
      }
      if (settlements.length > 0) {
        parts.push(`${settlements.length} settlement${settlements.length !== 1 ? "s" : ""}`);
      }
      console.log(
        `  Budget:                    ${parts.length > 0 ? parts.join(", ") : "present (empty)"}`,
      );
    }
  } else {
    console.log(`  Budget:                    not found, skipping`);
  }

  // 6. Gradient (gradient.json) — informational, no cryptographic verification
  const gradientPath = path.join(dirPath, "gradient.json");
  if (fs.existsSync(gradientPath)) {
    const gradientResult = readJsonFile(gradientPath);
    if (!gradientResult.ok) {
      console.log(`  Gradient:                  FAILED — ${gradientResult.error}`);
    } else {
      const gradientData = gradientResult.data as Record<string, unknown>;
      const composite =
        typeof gradientData["gradient"] === "number"
          ? gradientData["gradient"].toFixed(2)
          : "unknown";
      console.log(`  Gradient:                  composite: ${composite}`);
    }
  } else {
    console.log(`  Gradient:                  not found, skipping`);
  }

  // Summary
  console.log();
  if (passed) {
    console.log(`Bundle verification: PASSED`);
  } else {
    console.log(`Bundle verification: FAILED`);
  }
  console.log();
  process.exit(passed ? 0 : 1);
}
