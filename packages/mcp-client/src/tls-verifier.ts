/**
 * TLS Certificate Pinning Verifier.
 * Pins the server's TLS certificate fingerprint (SHA-256 of DER-encoded cert)
 * on first connect. Rejects on subsequent connects if the fingerprint changes.
 *
 * Node.js only — uses node:tls to probe the server's certificate.
 * Not available in browser environments.
 */

import * as tls from "node:tls";
import type { McpServerConfig, ServerVerifier, VerificationResult } from "./index.js";
import type { ToolDefinition } from "@motebit/sdk";

/** Probe a TLS server and return the SHA-256 fingerprint of its certificate. */
async function probeTlsCertificate(hostname: string, port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: true, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        if (cert == null || !cert.fingerprint256) {
          socket.destroy();
          reject(new Error(`No TLS certificate from ${hostname}:${String(port)}`));
          return;
        }
        // fingerprint256 is SHA-256 in colon-separated hex format (e.g., "AB:CD:EF:...")
        // Normalize to lowercase hex without colons for consistent comparison
        const fingerprint = cert.fingerprint256.replace(/:/g, "").toLowerCase();
        socket.destroy();
        resolve(fingerprint);
      },
    );
    socket.on("error", (err: Error) => {
      socket.destroy();
      reject(new Error(`TLS probe failed for ${hostname}:${String(port)}: ${err.message}`));
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS probe timed out for ${hostname}:${String(port)}`));
    });
  });
}

/**
 * Verifies server identity by pinning the TLS certificate fingerprint.
 * On first connect (no pinned fingerprint), accepts and pins.
 * On subsequent connects, rejects if the certificate changed.
 */
export class TlsCertificateVerifier implements ServerVerifier {
  async verify(config: McpServerConfig, _tools: ToolDefinition[]): Promise<VerificationResult> {
    if (!config.url) {
      // stdio transport — no TLS to verify
      return { ok: true };
    }

    let hostname: string;
    let port: number;
    try {
      const parsed = new URL(config.url);
      if (parsed.protocol !== "https:") {
        // Non-HTTPS — skip TLS verification (e.g., localhost dev)
        return { ok: true };
      }
      hostname = parsed.hostname;
      port = parsed.port ? parseInt(parsed.port, 10) : 443;
    } catch {
      return { ok: false, error: `Invalid server URL: ${config.url}` };
    }

    let fingerprint: string;
    try {
      fingerprint = await probeTlsCertificate(hostname, port);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }

    if (!config.tlsCertFingerprint) {
      // First connect — pin the certificate
      return {
        ok: true,
        configUpdates: { tlsCertFingerprint: fingerprint },
      };
    }

    if (config.tlsCertFingerprint === fingerprint) {
      return { ok: true };
    }

    return {
      ok: false,
      error: `TLS certificate changed for ${hostname}. Expected fingerprint ${config.tlsCertFingerprint.slice(0, 16)}..., got ${fingerprint.slice(0, 16)}...`,
    };
  }
}
