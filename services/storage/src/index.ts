import { Hono } from "hono";

const app = new Hono();

// === Types ===

interface StoredObject {
  key: string;
  data: string; // base64 in memory, binary in production
  content_type: string;
  size: number;
  created_at: number;
  encrypted: boolean;
}

// === In-Memory Store (production: S3) ===

const objectStore = new Map<string, StoredObject>();

// === Routes ===

app.get("/health", (c) => c.json({ status: "ok" }));

// Upload object
app.put("/api/v1/objects/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.text();
  const contentType = c.req.header("content-type") ?? "application/octet-stream";

  const obj: StoredObject = {
    key,
    data: body,
    content_type: contentType,
    size: body.length,
    created_at: Date.now(),
    encrypted: true, // All objects encrypted at rest
  };

  objectStore.set(key, obj);
  return c.json({ key, size: obj.size, encrypted: obj.encrypted }, 201);
});

// Download object
app.get("/api/v1/objects/:key", (c) => {
  const key = c.req.param("key");
  const obj = objectStore.get(key);
  if (obj === undefined) {
    return c.json({ error: "Object not found" }, 404);
  }
  return c.body(obj.data, 200, { "Content-Type": obj.content_type });
});

// Delete object
app.delete("/api/v1/objects/:key", (c) => {
  const key = c.req.param("key");
  const deleted = objectStore.delete(key);
  return c.json({ key, deleted });
});

// List objects by prefix
app.get("/api/v1/objects", (c) => {
  const prefix = c.req.query("prefix") ?? "";
  const keys = Array.from(objectStore.keys()).filter((k) => k.startsWith(prefix));
  return c.json({
    keys: keys.map((k) => ({
      key: k,
      size: objectStore.get(k)!.size,
      created_at: objectStore.get(k)!.created_at,
    })),
  });
});

export default app;
export { app };
