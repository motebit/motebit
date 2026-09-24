/**
 * Opening a URL the RELAY handed us in the operator's browser.
 *
 * The checkout URL crosses a trust boundary: the CLI supports custom relays,
 * so `checkout_url` is attacker-influenced input. It must never be
 * interpolated into a shell string (`open "${url}"` — a URL containing
 * `"; rm -rf ~; "` is a command), and it must be a real HTTPS URL before we
 * hand it to the platform opener at all.
 *
 * Two seams, both pure enough to test without a browser:
 *   - `safeExternalUrl` — parse + scheme policy (HTTPS; plain HTTP only for
 *     loopback, the local-relay dev shape).
 *   - `openInBrowser` — `execFile` with an argv array, `shell: false`. No
 *     string is ever built.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Parse an external URL and enforce the scheme policy. `null` = refuse. */
export function safeExternalUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

export interface Opener {
  execFile(file: string, args: readonly string[], opts: { stdio: "ignore" }): unknown;
}

/**
 * Open a validated URL with the platform opener. The URL is passed as ONE
 * argv element — never through a shell. Throws if the opener fails; callers
 * fall back to printing the URL.
 */
export async function openInBrowser(url: URL, opener?: Opener): Promise<void> {
  const exec: Opener =
    opener ??
    (await import("node:child_process").then((m) => ({
      execFile: (file, args, opts) => m.execFileSync(file, [...args], opts),
    })));
  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  exec.execFile(openCmd, [url.href], { stdio: "ignore" });
}
