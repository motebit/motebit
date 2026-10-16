import { describe, it, expect } from "vitest";
import fsDefault, * as realFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheRelativePath,
  createAtomicModelCache,
  evictCachedModel,
  installAtomicModelCache,
  nodeFs,
  type ModelCacheFs,
} from "../model-cache";

const HOST = "https://huggingface.co/";
const KEY = `${HOST}Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx`;

/** In-memory fs that records every call, so write ordering is observable. */
function memFs(): ModelCacheFs & { files: Map<string, Uint8Array>; log: string[] } {
  const files = new Map<string, Uint8Array>();
  const log: string[] = [];
  return {
    files,
    log,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
    mkdirSync: (p) => log.push(`mkdir ${p}`),
    writeFileSync: (p, d) => {
      log.push(`write ${p}`);
      files.set(p, d);
    },
    renameSync: (from, to) => {
      log.push(`rename ${from} -> ${to}`);
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    rmSync: (p) => {
      log.push(`rm ${p}`);
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    },
  };
}

describe("cacheRelativePath", () => {
  it("maps a main-revision model URL to transformers' FileCache layout", () => {
    expect(cacheRelativePath(KEY, HOST)).toBe("Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx");
    expect(cacheRelativePath(KEY, "https://huggingface.co")).toBe(
      "Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
    );
  });

  it("does not cache local paths, pinned revisions, other hosts or path climbs", () => {
    expect(cacheRelativePath("/models/Xenova/all-MiniLM-L6-v2/config.json", HOST)).toBeUndefined();
    expect(cacheRelativePath(`${HOST}Xenova/m/resolve/v2/config.json`, HOST)).toBeUndefined();
    expect(cacheRelativePath("https://evil.example/Xenova/m/resolve/main/x", HOST)).toBeUndefined();
    expect(
      cacheRelativePath(`${HOST}Xenova/m/resolve/main/../../etc/passwd`, HOST),
    ).toBeUndefined();
  });
});

describe("createAtomicModelCache", () => {
  it("writes to a unique temp file, then renames — a reader never sees a prefix", async () => {
    const fs = memFs();
    const cache = createAtomicModelCache(fs, "/c", HOST);
    await cache.put(KEY, new Response(new Uint8Array([1, 2, 3])));
    const target = "/c/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx";
    const write = fs.log.find((l) => l.startsWith("write "))!;
    const tmp = write.slice("write ".length);
    expect(tmp).not.toBe(target);
    expect(tmp.startsWith(`${target}.`) && tmp.endsWith(".tmp")).toBe(true);
    expect(fs.log).toContain(`rename ${tmp} -> ${target}`);
    expect([...fs.files.keys()]).toEqual([target]);

    const hit = await cache.match(KEY);
    expect(hit?.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("misses on an absent file or an uncacheable key; ignores puts of uncacheable keys", async () => {
    const fs = memFs();
    const cache = createAtomicModelCache(fs, "/c", HOST);
    expect(await cache.match(KEY)).toBeUndefined();
    expect(await cache.match("/models/x")).toBeUndefined();
    await cache.put("/models/x", new Response("x"));
    expect(fs.files.size).toBe(0);
  });

  it("a failed write leaves no temp file and does not throw (caching is best-effort)", async () => {
    const fs = memFs();
    fs.renameSync = () => {
      throw new Error("EXDEV");
    };
    const cache = createAtomicModelCache(fs, "/c", HOST);
    await expect(cache.put(KEY, new Response("x"))).resolves.toBeUndefined();
    expect(fs.files.size).toBe(0);
  });

  it("round-trips through the real file system", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-model-cache-"));
    try {
      const cache = createAtomicModelCache(realFs as unknown as ModelCacheFs, dir, HOST);
      await cache.put(KEY, new Response(new Uint8Array([9, 8, 7])));
      const hit = await cache.match(KEY);
      expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
      expect(realFs.readdirSync(join(dir, "Xenova", "all-MiniLM-L6-v2", "onnx"))).toEqual([
        "model_quantized.onnx",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evictCachedModel", () => {
  it("removes the model's cached files, never a path outside the cache", () => {
    const fs = memFs();
    fs.files.set("/c/Xenova/m/onnx/model.onnx", new Uint8Array([1]));
    fs.files.set("/c/Other/n/config.json", new Uint8Array([1]));
    evictCachedModel(fs, "/c", "Xenova/m");
    expect([...fs.files.keys()]).toEqual(["/c/Other/n/config.json"]);
    evictCachedModel(fs, "/c", "../etc");
    expect(fs.log.filter((l) => l.startsWith("rm "))).toEqual(["rm /c/Xenova/m"]);
  });
});

describe("installAtomicModelCache", () => {
  it("takes over from transformers' FileCache, idempotently", () => {
    const fs = memFs();
    const env: Record<string, unknown> = { useFSCache: true, cacheDir: "/c", remoteHost: HOST };
    expect(installAtomicModelCache(env, fs)).toBe("/c");
    const first = env.customCache;
    expect(env).toMatchObject({ useFSCache: false, useCustomCache: true });
    expect(installAtomicModelCache(env, fs)).toBe("/c");
    expect(env.customCache).toBe(first);
    // Re-pointed at another directory: a fresh cache for the new one.
    env.cacheDir = "/d";
    expect(installAtomicModelCache(env, fs)).toBe("/d");
    expect(env.customCache).not.toBe(first);
  });

  it("leaves env alone without a file system, a cache dir, or when the FS cache is off", () => {
    const off: Record<string, unknown> = { useFSCache: false, cacheDir: "/c" };
    expect(installAtomicModelCache(off, memFs())).toBeUndefined();
    expect(off.useCustomCache).toBeUndefined();
    const noDir: Record<string, unknown> = { useFSCache: true, cacheDir: null };
    expect(installAtomicModelCache(noDir, memFs())).toBeUndefined();
    expect(
      installAtomicModelCache({ useFSCache: true, cacheDir: "/c" }, undefined),
    ).toBeUndefined();
    // A user-supplied custom cache is never replaced.
    const own = { match: () => {}, put: () => {} };
    const user: Record<string, unknown> = {
      useFSCache: false,
      useCustomCache: true,
      customCache: own,
      cacheDir: "/c",
    };
    expect(installAtomicModelCache(user, memFs())).toBeUndefined();
    expect(user.customCache).toBe(own);
  });

  it("an installed cache someone switched off is reported as not in use", () => {
    const env: Record<string, unknown> = { useFSCache: true, cacheDir: "/c", remoteHost: HOST };
    installAtomicModelCache(env, memFs());
    env.useCustomCache = false;
    expect(installAtomicModelCache(env, memFs())).toBeUndefined();
  });
});

describe("nodeFs", () => {
  it("is node:fs under Node, undefined where process.getBuiltinModule is absent", () => {
    expect(nodeFs()).toBe(fsDefault);
    const saved = globalThis.process.getBuiltinModule;
    try {
      (globalThis.process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
      expect(nodeFs()).toBeUndefined();
    } finally {
      globalThis.process.getBuiltinModule = saved;
    }
  });
});
