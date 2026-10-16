/**
 * On-disk cache for the local embedding model, hardened for many processes.
 *
 * @xenova/transformers' own FileCache writes with a plain `writeFile` into ONE
 * directory (inside the installed package — in a pnpm workspace, a single
 * store copy shared by every package and every test worker). A process that
 * reads while another is still writing gets a truncated .onnx, and
 * onnxruntime fails with "Failed to load model because protobuf parsing
 * failed"; the torn file then stays on disk and fails every later load.
 *
 * This cache keeps the same on-disk layout (`<cacheDir>/<model>/<file>`, so
 * an existing cache is reused) but:
 *  - writes atomically — a uniquely named temp file, then `rename`, so a
 *    reader sees the old file, no file, or the whole new file, never a prefix;
 *  - lets the caller evict a model whose cached files failed to load, so a
 *    torn file left by the old writer is re-fetched instead of failing forever.
 *
 * Node only. `fs` is reached through `process.getBuiltinModule` (no static
 * `node:` import) so browser bundles of memory-graph never see it; where it
 * is unavailable the caller leaves transformers' defaults alone.
 */

/** The slice of `node:fs` this cache uses — injected so tests can fake it. */
export interface ModelCacheFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  mkdirSync(path: string, opts: { recursive: true }): unknown;
  writeFileSync(path: string, data: Uint8Array): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, opts: { recursive: true; force: true }): void;
}

/** The Web-Cache-API subset transformers calls on `env.customCache`. */
export interface ModelFileCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/** The transformers `env` fields this module reads and writes. */
export interface TransformersCacheEnv {
  cacheDir?: string | null;
  remoteHost?: string;
  useFSCache?: boolean;
  useCustomCache?: boolean;
  customCache?: unknown;
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p !== "")
    .join("/");
}

/**
 * Map a transformers cache key (the remote URL of a model file on the
 * default `main` revision) to its relative path `<model>/<file>` — the
 * layout transformers' FileCache uses. Anything else (a local path key, a
 * pinned revision, another host) is not cached here: `undefined`.
 */
export function cacheRelativePath(request: string, remoteHost: string): string | undefined {
  const host = remoteHost.endsWith("/") ? remoteHost : `${remoteHost}/`;
  if (!request.startsWith(host)) return undefined;
  const m = /^(.+?)\/resolve\/main\/(.+)$/.exec(request.slice(host.length));
  if (m === null) return undefined;
  const rel = `${m[1]}/${m[2]}`;
  // Never let a key climb out of the cache directory.
  if (rel.split("/").some((seg) => seg === ".." || seg === "")) return undefined;
  return rel;
}

let tempCounter = 0;

/** Caches this module created, with their directory — so a re-install is recognised. */
const ours = new WeakMap<object, string>();

export function createAtomicModelCache(
  fs: ModelCacheFs,
  cacheDir: string,
  remoteHost: string,
): ModelFileCache {
  const cache: ModelFileCache = {
    match(request) {
      const rel = cacheRelativePath(request, remoteHost);
      if (rel === undefined) return Promise.resolve(undefined);
      const file = joinPath(cacheDir, rel);
      if (!fs.existsSync(file)) return Promise.resolve(undefined);
      const bytes = fs.readFileSync(file);
      return Promise.resolve(
        // A Buffer is a Uint8Array over an ArrayBufferLike; Response takes it as-is.
        new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { "content-length": String(bytes.byteLength) },
        }),
      );
    },
    async put(request, response) {
      const rel = cacheRelativePath(request, remoteHost);
      if (rel === undefined) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const file = joinPath(cacheDir, rel);
      fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      const pid = typeof process !== "undefined" ? process.pid : 0;
      const tmp = `${file}.${pid}.${Date.now()}.${tempCounter++}.tmp`;
      try {
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file);
      } catch {
        // Caching is best-effort: the model is already in memory.
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
  ours.set(cache, cacheDir);
  return cache;
}

/** Delete every cached file of `model` so the next load fetches it fresh. */
export function evictCachedModel(fs: ModelCacheFs, cacheDir: string, model: string): void {
  if (model.split("/").some((seg) => seg === ".." || seg === "")) return;
  fs.rmSync(joinPath(cacheDir, model), { recursive: true, force: true });
}

/** `node:fs` when running under Node (≥ 22.3), else `undefined`. */
export function nodeFs(): ModelCacheFs | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return proc?.getBuiltinModule?.("node:fs") as ModelCacheFs | undefined;
}

/**
 * Route transformers' file cache through the atomic cache. Returns the cache
 * directory in use, or `undefined` when there is no file system (browser) or
 * no cache directory, in which case `env` is left untouched.
 */
export function installAtomicModelCache(
  env: TransformersCacheEnv,
  fs: ModelCacheFs | undefined,
): string | undefined {
  const cacheDir = env.cacheDir;
  if (fs === undefined || typeof cacheDir !== "string") return undefined;
  const current = env.customCache;
  const prior = typeof current === "object" && current !== null ? ours.get(current) : undefined;
  if (prior === cacheDir) return env.useCustomCache === true ? cacheDir : undefined;
  // Only take over from transformers' own FileCache (or from ours, re-pointed).
  if (env.useFSCache !== true && prior === undefined) return undefined;
  env.customCache = createAtomicModelCache(
    fs,
    cacheDir,
    env.remoteHost ?? "https://huggingface.co/",
  );
  env.useCustomCache = true;
  // transformers consults its FileCache before a custom cache: switch it off.
  env.useFSCache = false;
  return cacheDir;
}
