import { describe, it, expect, vi } from "vitest";
import { openInBrowser, safeExternalUrl } from "../open-external.js";

describe("safeExternalUrl — the relay's checkout_url is attacker-influenced input", () => {
  it("accepts https and loopback http only", () => {
    expect(safeExternalUrl("https://checkout.stripe.com/c/pay/cs_test_123")?.href).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_123",
    );
    expect(safeExternalUrl("http://localhost:3300/checkout")?.hostname).toBe("localhost");
    expect(safeExternalUrl("http://127.0.0.1:3300/x")).not.toBeNull();
  });

  it("refuses non-https, credentials, junk, and non-strings", () => {
    for (const bad of [
      "http://evil.example/checkout",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pw@example.com/",
      "not a url",
      "",
      undefined,
      42,
      { href: "https://x" },
    ]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
});

describe("openInBrowser — argv, never a shell", () => {
  it("passes the URL as one argument; shell metacharacters stay inert", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const opener = {
      execFile: (file: string, args: readonly string[]) => calls.push({ file, args }),
    };
    const hostile = 'https://checkout.stripe.com/pay?x="; touch /tmp/pwned; $(id) `id` #';
    const url = safeExternalUrl(hostile);
    expect(url).not.toBeNull();
    await openInBrowser(url!, opener);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toHaveLength(1);
    // The whole hostile string is a single argv element, URL-encoded by the
    // URL parser — nothing here is ever seen by a shell.
    expect(calls[0]!.args[0]).toBe(url!.href);
    expect(calls[0]!.args[0]).toContain("touch");
    expect(["open", "xdg-open", "explorer"]).toContain(calls[0]!.file);
  });

  it("propagates opener failure so the caller can print the URL instead", async () => {
    const opener = {
      execFile: vi.fn(() => {
        throw new Error("no display");
      }),
    };
    await expect(openInBrowser(new URL("https://example.com"), opener)).rejects.toThrow(
      "no display",
    );
  });
});
