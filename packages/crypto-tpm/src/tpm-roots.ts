/**
 * Pinned TPM 2.0 Endorsement-Key vendor root certificates.
 *
 * Every `platform: "tpm"` hardware-attestation claim must chain to one of
 * the root CAs listed here. Pinning is the self-attesting contract — a
 * verifier that dynamically fetched vendor CAs could not be reproduced
 * by a third-party audit. By committing the exact bytes of the CAs we
 * accept, anyone can audit this file, pin the same bytes in their own
 * verifier, and reach the same yes/no answer.
 *
 * The TPM ecosystem is multi-vendor by design: every Windows 11 device
 * ships with TPM 2.0 (Microsoft's mandatory requirement), every modern
 * Linux-on-x86 laptop has one, every Mac with a T2 chip has one. Each
 * vendor maintains a public CA bundle rooted at their Endorsement-Key
 * issuer. The motebit policy pins the four most common:
 *
 *   - Infineon          (`OptigaTrustM`, `SLB966x` families)
 *   - Nuvoton            (`NPCT7xx` family)
 *   - STMicroelectronics (`ST33TPHF2ESPI`, `ST33HTPH2E32AHB3` families)
 *   - Intel PTT          (firmware TPM bundled with Intel CSME)
 *
 * AMD fTPM (firmware TPM bundled with AMD PSP) uses a vendor-signed
 * chain that roots to AMD's EK CA; that root is additive and lands in
 * a subsequent pass once the first AMD-shaped test vector is captured.
 *
 * ## Operator follow-up — ship-blocking for production rollout
 *
 * The PEMs below are declared as exported constants so the test suite
 * exercises the same chain-verification code path end-to-end. For a
 * production ship, an operator must replace each placeholder with the
 * exact byte-for-byte vendor root published at the URL in the comment.
 * The test fabrication pattern (`buildFakeChain` in `__tests__`) does
 * not need the real bytes — tests inject their own roots — so swapping
 * in the real vendor PEMs is a mechanical operator task, not a code
 * change. The drift gate `check-hardware-attestation-primitives` covers
 * the parser / composer contract; the vendor-root swap is tracked in
 * `docs/doctrine/hardware-attestation.md` §Non-goals.
 */

/**
 * Infineon OPTIGA TPM 2.0 Endorsement Key Root CA.
 *
 * Published at: https://pki.infineon.com/OptigaEccRootCA/OptigaEccRootCA.crt
 *
 * Placeholder PEM — replace with the real vendor bytes before
 * production rollout. Tests override via `rootPems` option.
 */
export const INFINEON_TPM_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBdjCCARygAwIBAgIJAIMw8f7k8+xyMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMM
F01vdGViaXQgSW5maW5lb24gUGxhY2Vob2xkZXIwHhcNMjYwNDIyMDAwMDAwWhcN
NDYwNDIyMDAwMDAwWjAiMSAwHgYDVQQDDBdNb3RlYml0IEluZmluZW9uIFBsYWNl
aG9sZGVyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKZ/4LNYqi/LAI4R6tS2K
kRUnhkRzkYfi5hmz2E+35mqWVNqCb/FRhk6dEuxCNbwJxFPEK4Opf5lCOs0ZsRdF
+KNCMEAwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQp3ojpUGm1YB9N+9lQHg0s
VpSoBTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCjxfFCCf6t
CpGcGc7Gsk8h2RFQ7CFW8NzkjuvUZZ7bwwIhAJ/CB4+XzV5EhcOf0qRZN8zmJb8G
B9Z9EFcZ7Nt1l4Tn
-----END CERTIFICATE-----
`;

/**
 * Nuvoton NPCT TPM 2.0 Endorsement Key Root CA.
 *
 * Published at: https://www.nuvoton.com/security/NTC-TPM-EK-Cert/Nuvoton TPM Root CA 2110.cer
 *
 * Placeholder PEM — replace with the real vendor bytes before
 * production rollout. Tests override via `rootPems` option.
 */
export const NUVOTON_TPM_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBczCCARmgAwIBAgIJAL7X6p2yXxJJMAoGCCqGSM49BAMCMCAxHjAcBgNVBAMM
FU1vdGViaXQgTnV2b3RvbiBQbGFjZWhvbGRlcjAeFw0yNjA0MjIwMDAwMDBaFw00
NjA0MjIwMDAwMDBaMCAxHjAcBgNVBAMMFU1vdGViaXQgTnV2b3RvbiBQbGFjZWhv
bGRlcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJgPwHoU+cVjX3HzkXpEksdn
f3KPRwMbFYvE3tkqDcW8JqzG8qO5VwPKFPwoAEE2C8dJpKHEk7fA4iGrSXz7x/6j
QjBAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUNskUYy3Uz8Tvuvbu/B5VTJA2
lLcwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAAbU6/dL06n8Cw
CYI/rHo/cLWEFQKH5VnzDJH4RN5fIgIgAN0F3fYbTBa9H8OXCJdXUDxSDr2iT8E5
VDz6f2s3uFo=
-----END CERTIFICATE-----
`;

/**
 * STMicroelectronics ST33 TPM 2.0 Endorsement Key Root CA.
 *
 * Published at: https://sw-center.st.com/STM_ROOT_CA_2.crt
 *
 * Placeholder PEM — replace with the real vendor bytes before
 * production rollout. Tests override via `rootPems` option.
 */
export const STMICRO_TPM_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBdDCCARqgAwIBAgIJAMZ4+9xZHMuaMAoGCCqGSM49BAMCMCExHzAdBgNVBAMM
Fk1vdGViaXQgU1RNaWNybyBQbGFjZWhvbGRlcjAeFw0yNjA0MjIwMDAwMDBaFw00
NjA0MjIwMDAwMDBaMCExHzAdBgNVBAMMFk1vdGViaXQgU1RNaWNybyBQbGFjZWhv
bGRlcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABLnK3t7y4JBJxzE0EFq+zsOV
+m9n9D1YDUFb7k6hVIsKvfoH9o3rZkc4uRuSsz7fjC+IsKsMrJKXaU0mxH6ncjej
QjBAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUe/x8wdJYzEypFT3M0K1Jy5C6
1j8wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAc9Ln4qhL7fZ5c
oUbLFsTVTEc4aeBMkxqzLrJpZOYVegIgWSfLj2Q5CQ8OFvJx8fVDkxN9OXjYT6Jm
H6Bvb0gQaG8=
-----END CERTIFICATE-----
`;

/**
 * Intel PTT (Platform Trust Technology, firmware TPM inside Intel CSME)
 * Endorsement Key Root CA.
 *
 * Published at: https://upgrades.intel.com/content/CRL/ekcert/EKRootPublicKey.cer
 *
 * Placeholder PEM — replace with the real vendor bytes before
 * production rollout. Tests override via `rootPems` option.
 */
export const INTEL_PTT_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBcjCCARegAwIBAgIJAOQz8pPRrTIxMAoGCCqGSM49BAMCMB8xHTAbBgNVBAMM
FE1vdGViaXQgSW50ZWwgUGxhY2Vob2xkZXIwHhcNMjYwNDIyMDAwMDAwWhcNNDYw
NDIyMDAwMDAwWjAfMR0wGwYDVQQDDBRNb3RlYml0IEludGVsIFBsYWNlaG9sZGVy
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkxD3N3JQMgVV8gRZEiQLBPyxX5jw
WHNJCt8Fc0BbzQZVZ6Vkg4J1oHkLXIpsWcNOwU1RXcE/Pzr2yIjTnJW2VKNCMEAw
DgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQxu9vHJmf+rQznfCVCd9vNQTRwPjAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCbX9rmZqJgk7lYPXGj
WBR+oXt4AYzQ8pQvTSfkG/DBYwIgEY/oKZl5QL3Jt7lJx6lJxF3vLkaKBnJ9t4K4
gHQ4nCY=
-----END CERTIFICATE-----
`;

/**
 * Default pinned-root set returned when a caller passes no `rootPems`
 * override. Ordered by deployment prevalence — Infineon and Intel PTT
 * together cover the vast majority of Windows 11 hosts; Nuvoton and
 * STMicro cover most non-Intel Linux laptops.
 */
export const DEFAULT_PINNED_TPM_ROOTS: readonly string[] = [
  INFINEON_TPM_EK_ROOT_PEM,
  NUVOTON_TPM_EK_ROOT_PEM,
  STMICRO_TPM_EK_ROOT_PEM,
  INTEL_PTT_EK_ROOT_PEM,
];

/**
 * Sentinel value the consumer-facing verifier emits on a mint path
 * where the Rust bridge returns a `not_supported` failure envelope.
 * Exposed as a constant so call sites match on a named token rather
 * than a raw string literal.
 */
export const TPM_PLATFORM = "tpm" as const;
