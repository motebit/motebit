import { describe, expect, it } from "vitest";
import {
  encodeFrame,
  JsonLineDecoder,
  MAX_FRAME_BYTES,
  type HelloMessage,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "../protocol.js";

const hello: HelloMessage = {
  t: "hello",
  protocol_version: RUNTIME_HOST_PROTOCOL_VERSION,
  token: "a.b",
};

describe("encodeFrame / JsonLineDecoder", () => {
  it("round-trips a message", () => {
    const decoder = new JsonLineDecoder();
    const frames = decoder.push(encodeFrame(hello));
    expect(frames).toEqual([hello]);
  });

  it("reassembles a frame split across pushes", () => {
    const decoder = new JsonLineDecoder();
    const wire = encodeFrame(hello);
    expect(decoder.push(wire.slice(0, 10))).toEqual([]);
    expect(decoder.push(wire.slice(10))).toEqual([hello]);
  });

  it("splits multiple frames arriving in one push", () => {
    const decoder = new JsonLineDecoder();
    const frames = decoder.push(encodeFrame(hello) + encodeFrame({ t: "end", id: "x" }));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ t: "end", id: "x" });
  });

  it("decodes Uint8Array input", () => {
    const decoder = new JsonLineDecoder();
    const frames = decoder.push(new TextEncoder().encode(encodeFrame(hello)));
    expect(frames).toEqual([hello]);
  });

  it("skips blank lines", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push(`\n  \n${encodeFrame(hello)}`)).toEqual([hello]);
  });

  it("throws on malformed JSON", () => {
    const decoder = new JsonLineDecoder();
    expect(() => decoder.push("not json\n")).toThrow(/malformed frame/);
  });

  it("throws on non-object frames", () => {
    const decoder = new JsonLineDecoder();
    expect(() => decoder.push("42\n")).toThrow(/not a JSON object/);
    expect(() => new JsonLineDecoder().push("[1,2]\n")).toThrow(/not a JSON object/);
    expect(() => new JsonLineDecoder().push("null\n")).toThrow(/not a JSON object/);
  });

  it("throws once the buffer exceeds the frame ceiling", () => {
    const decoder = new JsonLineDecoder();
    const big = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => decoder.push(big)).toThrow(/exceeds/);
  });
});
