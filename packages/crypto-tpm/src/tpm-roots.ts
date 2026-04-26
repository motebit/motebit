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
 *   - STMicroelectronics (`ST33TPHF2ESPI`, `ST33HTPH2E32AHB3`,
 *                         `ST33KTPM2X` families) — RSA + ECC parallel
 *                         roots; both pinned
 *   - Intel PTT          (firmware TPM bundled with Intel CSME)
 *
 * AMD fTPM (firmware TPM bundled with AMD PSP) uses a vendor-signed
 * chain that roots to AMD's EK CA; that root is additive and lands in
 * a subsequent pass once the first AMD-shaped test vector is captured.
 *
 * ## Real-fixture coverage is a separate concern
 *
 * Pinning the production vendor root bytes (this file) is one half of
 * the moat-provability claim. The other half — proving the verifier
 * agrees with what real hardware emits in the wild — requires a
 * captured TPM2_Quote from an actual device with its full AK→vendor-
 * root chain. Real-device captures expose serial-number-grade chip
 * identity (each device's EK cert is unique by design), so projects
 * systemically don't publish them. Real-fixture coverage stays deferred
 * to an owned-hardware capture session; see
 * `docs/doctrine/hardware-attestation.md` §"Real TPM fixture status".
 * The `rootPems` test override path remains for synthetic chain-
 * verification tests that don't require a real-device fixture.
 *
 * Each constant below ships its real vendor-published bytes. Each
 * comment names: source URL, subject DN, SHA-256 fingerprint, and
 * validity window. The fingerprint is the audit anchor — a third-party
 * verifier that fetches the same vendor URL and computes its own
 * SHA-256 should reach the byte-identical value below.
 */

/**
 * Infineon OPTIGA(TM) ECC Root CA.
 *
 *   Source:     https://pki.infineon.com/OptigaEccRootCA/OptigaEccRootCA.crt
 *   Subject:    C=DE, O=Infineon Technologies AG, OU=OPTIGA(TM) Devices,
 *               CN=Infineon OPTIGA(TM) ECC Root CA
 *   SHA-256:    cfeb02fecd55ad7a73c6e1d11985d4c47dee248ab63dcb66091a2489660443c3
 *   Public key: ECDSA P-384
 *   Validity:   2013-07-26 → 2043-07-25
 */
export const INFINEON_TPM_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICWzCCAeKgAwIBAgIBBDAKBggqhkjOPQQDAzB3MQswCQYDVQQGEwJERTEhMB8G
A1UECgwYSW5maW5lb24gVGVjaG5vbG9naWVzIEFHMRswGQYDVQQLDBJPUFRJR0Eo
VE0pIERldmljZXMxKDAmBgNVBAMMH0luZmluZW9uIE9QVElHQShUTSkgRUNDIFJv
b3QgQ0EwHhcNMTMwNzI2MDAwMDAwWhcNNDMwNzI1MjM1OTU5WjB3MQswCQYDVQQG
EwJERTEhMB8GA1UECgwYSW5maW5lb24gVGVjaG5vbG9naWVzIEFHMRswGQYDVQQL
DBJPUFRJR0EoVE0pIERldmljZXMxKDAmBgNVBAMMH0luZmluZW9uIE9QVElHQShU
TSkgRUNDIFJvb3QgQ0EwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQm1HxLVgvAu1q2
GM+ymTz12zdTEu0JBVG9CdsVEJv/pE7pSWOlsG3YwU792YAvjSy7zL+WtDK40KGe
Om8bSWt46QJ00MQUkYxz6YqXbb14BBr06hWD6u6IMBupNkPd9pKjQjBAMB0GA1Ud
DgQWBBS0GIXISkrFEnryQDnexPWLHn5K0TAOBgNVHQ8BAf8EBAMCAAYwDwYDVR0T
AQH/BAUwAwEB/zAKBggqhkjOPQQDAwNnADBkAjA6QZcV8DjjbPuKjKDZQmTRywZk
MAn8wE6kuW3EouVvBt+/2O+szxMe4vxj8R6TDCYCMG7c9ov86ll/jDlJb/q0L4G+
+O3Bdel9P5+cOgzIGANkOPEzBQM3VfJegfnriT/kaA==
-----END CERTIFICATE-----
`;

/**
 * Nuvoton TPM Root CA 2110.
 *
 *   Source:     https://www.nuvoton.com/security/NTC-TPM-EK-Cert/Nuvoton TPM Root CA 2110.cer
 *   Subject:    CN=Nuvoton TPM Root CA 2110, O=Nuvoton Technology Corporation, C=TW
 *   SHA-256:    4aebe77a51ed29959a7f9f5e07a24a558dee8167f3985d724995a541c258dfda
 *   Public key: ECDSA P-256
 *   Validity:   2015-10-19 → 2035-10-15
 */
export const NUVOTON_TPM_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICBjCCAaygAwIBAgIIP5MvnZk8FrswCgYIKoZIzj0EAwIwVTFTMB8GA1UEAxMY
TnV2b3RvbiBUUE0gUm9vdCBDQSAyMTEwMCUGA1UEChMeTnV2b3RvbiBUZWNobm9s
b2d5IENvcnBvcmF0aW9uMAkGA1UEBhMCVFcwHhcNMTUxMDE5MDQzMjAwWhcNMzUx
MDE1MDQzMjAwWjBVMVMwHwYDVQQDExhOdXZvdG9uIFRQTSBSb290IENBIDIxMTAw
JQYDVQQKEx5OdXZvdG9uIFRlY2hub2xvZ3kgQ29ycG9yYXRpb24wCQYDVQQGEwJU
VzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPv9uK2BNm8/nmIyNsc2/aKHV0WR
ptzge3jKAIgUMosQIokl4LE3iopXWD3Hruxjf9vkLMDJrTeK3hWh2ySS4ySjZjBk
MA4GA1UdDwEB/wQEAwICBDASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSf
u3mqD1JieL7RUJKacXHpajW+9zAfBgNVHSMEGDAWgBSfu3mqD1JieL7RUJKacXHp
ajW+9zAKBggqhkjOPQQDAgNIADBFAiEA/jiywhOKpiMOUnTfDmXsXfDFokhKVNTX
B6Xtqm7J8L4CICjT3/Y+rrSnf8zrBXqWeHDh8Wi41+w2ppq6Ev9orZFI
-----END CERTIFICATE-----
`;

/**
 * STSAFE RSA Root CA 02 — STMicroelectronics's RSA-PKI anchor for the
 * ST33 / STSAFE-TPM family. Modern ST33xxx devices provision EK certs
 * under either this RSA root or the parallel ECC root below; pin both.
 *
 *   Source:     https://sw-center.st.com/STSAFE/STSAFERsaRootCA02.crt
 *   Reference:  ST Technical Note TN1330
 *   Subject:    C=CH, O=STMicroelectronics NV, CN=STSAFE RSA Root CA 02
 *   SHA-256:    c8f179943356e13d9d84b100201cefabbf408880241e5329e60d950ce1dea623
 *   Public key: RSA-4096
 *   Validity:   2022-01-20 → 9999-12-31
 */
export const STMICRO_TPM_EK_RSA_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIFXjCCA0agAwIBAgIGVR0gAAACMA0GCSqGSIb3DQEBDAUAME0xCzAJBgNVBAYT
AkNIMR4wHAYDVQQKExVTVE1pY3JvZWxlY3Ryb25pY3MgTlYxHjAcBgNVBAMTFVNU
U0FGRSBSU0EgUm9vdCBDQSAwMjAgFw0yMjAxMjAwMDAwMDBaGA85OTk5MTIzMTAw
MDAwMFowTTELMAkGA1UEBhMCQ0gxHjAcBgNVBAoTFVNUTWljcm9lbGVjdHJvbmlj
cyBOVjEeMBwGA1UEAxMVU1RTQUZFIFJTQSBSb290IENBIDAyMIICIjANBgkqhkiG
9w0BAQEFAAOCAg8AMIICCgKCAgEAyDtHbW51K/pnDbnPdLQTls2U/bu/aDATTi1W
CZDAtFC9sWtCRK6jQ0SG9DCCys7ur170V3Q+HVov88FzH6bYg4TWY7+wEQKLR/4W
IgdCjcW3uXMimsh9tOb+UlfRMW0yEozi7F+F/v07lULTJg+itCOMASi/caV1ySYI
cX5z/5Woj3hDgJGa4scOoxdOfPg1GCkEjQPy7fG/IBt883palE/T4UNg1megfLcg
hjOrbaPTFB3qXmm6E07QDYMkPiqryz3v9MCnOw62EXGcQLFIK4DwPxySU7NxO0ta
DHXv+8B5ljv4Jtx5OLkDf9YAfjEg6ZOpsyIGKI+bgIoVYtGbXTDZAtoMKw3ystQX
va9ceQ4cIQQUjpH6nFm8dbm/TOrkZd6m9pmLftR6kTuzRd8hhKCwpfcKbxQlMI2u
TDVbw03IFUhk23uDSTOzsyOjB2f93SLEw1yTBuiYXhO2YHUHFJckbiuz7RdE4sjN
1J0LwxKKbm9kleYEP+Kah6IJ0Zs7vbP3WNZUpmt6/XTmszb+paTSpanUYbBr2/IE
aQCRiAlv0H26i5u4CjSHRjjRIqLAuGnpn0gZ2Zgs1espJwmey7MPKvTJtK1H+TQN
0HZW8DYtcdzPkpxqKndWIUR7JTnozVPCVOcirSPGdkSvhbAGPyoyv7ju86RnTiT0
NLz7SbECAwEAAaNCMEAwHQYDVR0OBBYEFHzCjb5uWdhKVANGmxMIANL48G0nMA4G
A1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBDAUAA4IC
AQCykiyYyHAXHzRBdqJ3QLr8qTDDNO3RdLToZmiFRdslaRr2RtlDDjcAEFKf1u/E
1qprZe926Ob5KxWIQREvDAgqAbRS9fd3+w6hZ+ZrmHNh5aH2UEgsfAi9vZ3K8BH/
rReqTm0oxCMz4socJ9tIpvGSZhJg6PDTidsIscr8iNcSsVYJO60wSMxn7tv+Buh+
ZgJFddzEYZqTuezsdiXswkAkwqTJY9KM1w0bFLHrmifkc0y6I+jeBgjGxMknz8G5
p7YX4GoeJp5LjM8z36qBFKcjkKpYEb2H+u6CxgXFsxu6nkB0pn3u2uNwmXTYIQKO
trcshrmoKUv7mDvtaNIa0blMTRTEZzkwrR1BsHm/Gz7NLhgkDIv9p1u5oiCwlebh
eJ1cDJ9I7puSBPiDDpkdvVPg0wNFPai/SAhjW0OaULcybVR7kXzST9/xerCoquYp
I+qLjTs+RqahgL5a9ZRPVABX3DwvnDCarwVqMSfRjGP4e8b2BspDM+wPTvQH1K4O
xk+qc9HT7YubzqhtJ/yfcYd/eKTsk60aNmknatNZDSFzq03lxN048n3D9mcjGDkR
15Kv5NX8DhZuCNcBddkGC96uYpgSvl089RgnSL/qPlM+QlVjPbqDpISd/z3X4RNb
vdT+agOdZZJRB1MROQXDnACVdQB1ba/DTO4UNEou27D03Q==
-----END CERTIFICATE-----
`;

/**
 * STSAFE ECC Root CA 02 — STMicroelectronics's ECC-PKI anchor for the
 * ST33 / STSAFE-TPM family. Sibling of the RSA root above; modern ST33
 * devices use one or the other depending on EK template firmware.
 *
 *   Source:     https://sw-center.st.com/STSAFE/STSAFEEccRootCA02.crt
 *   Reference:  ST Technical Note TN1330
 *   Subject:    C=CH, O=STMicroelectronics NV, CN=STSAFE ECC Root CA 02
 *   SHA-256:    fd1e7b68accd825636b27b3177c67402d463a7f04c97b6c47ab705fcdc1a04f6
 *   Public key: ECDSA P-521
 *   Validity:   2022-01-20 → 9999-12-31
 */
export const STMICRO_TPM_EK_ECC_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICWjCCAbugAwIBAgIGVR0gAAECMAoGCCqGSM49BAMEME0xCzAJBgNVBAYTAkNI
MR4wHAYDVQQKExVTVE1pY3JvZWxlY3Ryb25pY3MgTlYxHjAcBgNVBAMTFVNUU0FG
RSBFQ0MgUm9vdCBDQSAwMjAgFw0yMjAxMjAwMDAwMDBaGA85OTk5MTIzMTAwMDAw
MFowTTELMAkGA1UEBhMCQ0gxHjAcBgNVBAoTFVNUTWljcm9lbGVjdHJvbmljcyBO
VjEeMBwGA1UEAxMVU1RTQUZFIEVDQyBSb290IENBIDAyMIGbMBAGByqGSM49AgEG
BSuBBAAjA4GGAAQAJFgkbtp5mZpvISjL8zAUSSJXxXpPhxhSVGQfqU0GEjPBIMMD
KNvc23xCcyIsiFTMD4MZQ1wov0SaBE3M31bWx78BrbiPCJ4lXUvJWiwm9+v3EL1z
lznBtyJDYUkrUe2n7r8NH7kAQ1X/csItvyomECdRtm4wwD8VX1n+l3npVlMNOxWj
QjBAMB0GA1UdDgQWBBT1XLcHvEsXQiYkgEBLu3yAulo8vjAOBgNVHQ8BAf8EBAMC
AQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDBAOBjAAwgYgCQgC85uufYwd5
yelX2EKkjx7s8LP6qgcXHxkO1zZYrTU7umomS5beVyPf2hA12yPVG9VnYUqs9+RA
L0mbODJNfHR5yAJCAUf2a5qPe3a/BpZBoY7YI68nUt1UD8ScX+IbkLJQ6mPe8pNR
xRJfSy8RvtTJcPEqH7kpj5sZjlRC5GUG/3Sco8uX
-----END CERTIFICATE-----
`;

/**
 * Intel TPM EK Root Certificate (used by Intel PTT, the firmware TPM
 * bundled with Intel CSME).
 *
 *   Source:     https://upgrades.intel.com/content/CRL/ekcert/EKRootPublicKey.cer
 *   Subject:    C=US, ST=CA, L=Santa Clara, O=Intel Corporation,
 *               OU=TPM EK root cert signing, CN=www.intel.com
 *   SHA-256:    2e1b3ba79af56d758be51697621bc4b9e8cee0983db3e749c55eb9b37c6d2ae0
 *   Public key: ECDSA P-256
 *   Validity:   2014-01-15 → 2049-12-31
 */
export const INTEL_PTT_EK_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICdzCCAh6gAwIBAgIUB+dPf7a3IyJGO923z34oQLRP7pwwCgYIKoZIzj0EAwIw
gYcxCzAJBgNVBAYMAlVTMQswCQYDVQQIDAJDQTEUMBIGA1UEBwwLU2FudGEgQ2xh
cmExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMSEwHwYDVQQLDBhUUE0gRUsg
cm9vdCBjZXJ0IHNpZ25pbmcxFjAUBgNVBAMMDXd3dy5pbnRlbC5jb20wHhcNMTQw
MTE1MDAwMDAwWhcNNDkxMjMxMjM1OTU5WjCBhzELMAkGA1UEBgwCVVMxCzAJBgNV
BAgMAkNBMRQwEgYDVQQHDAtTYW50YSBDbGFyYTEaMBgGA1UECgwRSW50ZWwgQ29y
cG9yYXRpb24xITAfBgNVBAsMGFRQTSBFSyByb290IGNlcnQgc2lnbmluZzEWMBQG
A1UEAwwNd3d3LmludGVsLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJR9
gVEsjUrMb+E/dl19ywJsKZDnghmwVyG16dAfQ0Pftp1bjhtPEGEguvbLGRRopKWH
VscAOlTFnvCHq+6/9/SjZjBkMB8GA1UdIwQYMBaAFOhSBcJP2NLVpSFHFrbODHtb
uncPMB0GA1UdDgQWBBToUgXCT9jS1aUhRxa2zgx7W7p3DzASBgNVHRMBAf8ECDAG
AQH/AgEBMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNHADBEAiAldFScWQ6L
PQgW/YT+2GILcATEA2TgzASaCrG+AzL6FgIgLH8ABRzm028hRYR/JZVGkHiomzYX
VILmTjHwSL7uZBU=
-----END CERTIFICATE-----
`;

/**
 * @deprecated since `@motebit/crypto-tpm@1.1.0`. Use the explicit
 * `STMICRO_TPM_EK_RSA_ROOT_PEM` (RSA-PKI) and
 * `STMICRO_TPM_EK_ECC_ROOT_PEM` (ECC-PKI) names instead. ST runs
 * parallel RSA + ECC trust anchors; the single-PEM constant could
 * only ever name one of them. Kept as an alias for the ECC root
 * (the modern default for most ST33 EK templates) for one minor
 * release cycle. Removed in `@motebit/crypto-tpm@2.0.0`.
 */
export const STMICRO_TPM_EK_ROOT_PEM = STMICRO_TPM_EK_ECC_ROOT_PEM;

/**
 * Default pinned-root set returned when a caller passes no `rootPems`
 * override. Five real vendor bytes covering the four major TPM 2.0
 * silicon vendors (STMicroelectronics ships parallel RSA + ECC roots,
 * both pinned). Ordered by deployment prevalence — Infineon and Intel
 * PTT together cover the vast majority of Windows 11 hosts; Nuvoton
 * and STMicro cover most non-Intel Linux laptops and ST33-based
 * embedded systems.
 */
export const DEFAULT_PINNED_TPM_ROOTS: readonly string[] = [
  INFINEON_TPM_EK_ROOT_PEM,
  NUVOTON_TPM_EK_ROOT_PEM,
  STMICRO_TPM_EK_RSA_ROOT_PEM,
  STMICRO_TPM_EK_ECC_ROOT_PEM,
  INTEL_PTT_EK_ROOT_PEM,
];

/**
 * Sentinel value the consumer-facing verifier emits on a mint path
 * where the Rust bridge returns a `not_supported` failure envelope.
 * Exposed as a constant so call sites match on a named token rather
 * than a raw string literal.
 */
export const TPM_PLATFORM = "tpm" as const;
