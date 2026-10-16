/**
 * Child process for model-cache-corrupt.real.test.ts. Points the REAL
 * @xenova/transformers at a cache dir holding a truncated .onnx (what a reader
 * sees while another process is still writing the shared cache), forbids
 * remote fetches, then runs two concurrent first embeds — the shape of the
 * ai-core terrarium test that hung the pre-push run. Prints one JSON line.
 */
import { env } from "@xenova/transformers";

const cacheDir = process.argv[2];
if (cacheDir === undefined) throw new Error("usage: corrupt-model-cache-child <cacheDir>");
env.cacheDir = cacheDir;
env.allowRemoteModels = false;

// The BUILT module (run `pnpm build` first): Node's type stripping does not
// map the sources' `.js` specifiers to `.ts`. A non-literal keeps tsc from
// requiring dist/ to exist at typecheck time.
const embeddingsModule = "../../../dist/embeddings.js";
const { embedText } = (await import(embeddingsModule)) as typeof import("../../embeddings.js");
const t0 = Date.now();
const vecs = await Promise.all([embedText("alpha"), embedText("beta")]);
process.stdout.write(
  JSON.stringify({ ms: Date.now() - t0, lengths: vecs.map((v) => v.length) }) + "\n",
);
