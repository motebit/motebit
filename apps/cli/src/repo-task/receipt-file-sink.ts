/**
 * Node adapter for the runtime's durable `ToolReceiptSink` port
 * (packages/runtime/src/tool-receipt-sink.ts): one signed receipt per line
 * of a JSON-lines file, appended and fsync'd before `append` resolves, so a
 * receipt the run continued past is on disk. Any I/O error rejects, and the
 * runtime then stops the run (fail-closed).
 *
 * The file is created exclusively (it must not already exist: one file per
 * run, never appended to an older run's record) at 0600. Not wired to any
 * command yet (build step 4).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { ToolReceiptSink } from "@motebit/runtime";

import { fsyncDir } from "../durable-file.js";

export function createReceiptFileSink(
  file: string,
): ToolReceiptSink & { readonly file: string; close(): Promise<void> } {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND,
    0o600,
  );
  fsyncDir(path.dirname(file));
  let chain: Promise<void> = Promise.resolve();
  return {
    file,
    append(receipt) {
      // Serialized: the runtime never overlaps appends, but a sink must not
      // interleave lines even if a caller did.
      const next = chain.then(() => {
        const line = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
        let off = 0;
        while (off < line.length) off += fs.writeSync(fd, line, off, line.length - off);
        fs.fsyncSync(fd);
      });
      chain = next.catch(() => undefined);
      return next;
    },
    /** Close the file once every pending append has settled. */
    async close() {
      await chain;
      fs.closeSync(fd);
    },
  };
}

/** Read a receipt file back, line by line (for the bundle writer and tests). */
export function readReceiptFile(file: string): unknown[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}
