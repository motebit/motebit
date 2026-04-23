/**
 * Pinned FIDO-vendor root certificates the `packed`-attestation full-
 * attestation verifier accepts as trust anchors.
 *
 * This is the self-attesting contract: a verifier that dynamically
 * fetched FIDO Metadata Service roots would have no sovereign story —
 * third parties auditing our output could never reproduce the decision
 * without trusting our fetch path. By committing the exact bytes of the
 * CAs we accept, anyone can audit this file, pin the same bytes in their
 * own verifier, and reach the same yes/no answer for any WebAuthn
 * attestation they receive.
 *
 * Starter set (v1):
 *   - Apple WebAuthn Anonymous Attestation CA — the platform-authenticator
 *     root iOS/macOS `Touch ID` / `Face ID` / `Passkey` attestations
 *     chain to when a site requests `attestation: "direct"`.
 *     Source: https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem
 *
 *   - Yubico FIDO Root CA Serial 457200631 — the Yubico attestation
 *     root every modern YubiKey (FIDO2 / Security Key) leaf certifies
 *     under. Source: https://developers.yubico.com/PKI/yubico-ca-certs.txt
 *
 *   - Microsoft TPM Root CA 2014 — the root Microsoft TPM-backed
 *     platform-authenticator leaves chain to on Windows Hello setups.
 *     Source: https://www.microsoft.com/pkiops/certs/Microsoft%20TPM%20Root%20Certificate%20Authority%202014.crt
 *
 * Rotations land as additive constants and a dispatch arm on the
 * accept-set here. Removing a root is a wire-format break and MUST be
 * coordinated with a spec version bump.
 *
 * Tests override the accept-set via `WebAuthnVerifyOptions.rootPems` so
 * chain-validation exercises the same code path without needing a real
 * vendor-signed leaf.
 */

/**
 * Apple WebAuthn Anonymous Attestation Root CA.
 *
 * Published by Apple as the root for WebAuthn packed-attestation leaves
 * minted by iOS / macOS platform authenticators. Byte-for-byte match of
 * Apple's published certificate at
 * https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem.
 */
export const APPLE_WEBAUTHN_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICEjCCAZmgAwIBAgIQaB0BbHo84wIlpQGUKEdXcTAKBggqhkjOPQQDAzBLMR8w
HQYDVQQDDBZBcHBsZSBXZWJBdXRobiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJ
bmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTIwMDMxODE4MjEzMloXDTQ1MDMx
NTAwMDAwMFowSzEfMB0GA1UEAwwWQXBwbGUgV2ViQXV0aG4gUm9vdCBDQTETMBEG
A1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTB2MBAGByqGSM49
AgEGBSuBBAAiA2IABCJCQ2pTVhzjl4Wo6IhHtMSAzO2cv+H9DQKev3//fG59G11k
xu9eI0/7o6V5uShBpe1u6l6mS19S1FEh6yGljnZAJ+2GNP1mi/YK2kSXIuTHjxA/
pcoRf7XkOtO4o1qlcaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUJtdk
2cV4wlpn0afeaxLQG2PxxtcwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2cA
MGQCMFrZ+9DsJ1PW9hfNdBywZDsWDbWFp28it1d/5w2RPkRX3Bbn/UbDTNLx7Jr3
jAGGiQIwHFj+dJZYUJR786osByBelJYsVZd2GbHQu209b5RCmGQ21gWSw2PdMsSn
1LabATR4H7iIgXPxz8m8KiS1hXiz
-----END CERTIFICATE-----
`;

/**
 * Yubico FIDO Root CA — Serial 457200631.
 *
 * Root of trust for YubiKey FIDO2 / Security Key attestation leaves.
 * Byte-for-byte match of Yubico's published certificate at
 * https://developers.yubico.com/PKI/yubico-ca-certs.txt.
 */
export const YUBICO_FIDO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIEG0BT9zANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZ
dWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAw
MDBaGA8yMDUwMDkwNDAwMDAwMFowLjEsMCoGA1UEAxMjWXViaWNvIFUyRiBSb290
IENBIFNlcmlhbCA0NTcyMDA2MzEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/jwYuhBVlqaiYWEMsrWFisgJ+PtM91eSrpI4TK7U53mwCIawSDHy8vUmk
5N2KAj9abvT9NP5SMS1hQi3usxoYGonXQgfO6ZXyUA9a+KAkqdFnBnlyugSeCOep
8EdZFfsaRFtMjkwz5Gcz2Py4vIYvCdMHPtwaz0bVuzneueIEz6TnQjE63Rdt2zbw
nebwTG5ZybeWSwbzy+BJ34ZHcUhPAY89yJQXuE0IzMZFcEBbPNRbWECRKgjq//qT
9nmDOFVlSRCt2wiqPSzluwn+v+suQEBsUjTGMEd25tKXXTkNW21wIWbxeSyUoTXw
LvGS6xlwQSgNpk2qXYwf8iXg7VWZAgMBAAGjQjBAMB0GA1UdDgQWBBQgIvz0bNGJ
hjgpToksyKpP9xv9oDAPBgNVHRMECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAN
BgkqhkiG9w0BAQsFAAOCAQEAjvjuOMDSa+JXFCLyBKsycXtBVZsJ4Ue3LbaEsPY4
MYN/hIQ5ZM5p7EjfcnMG4CtYkNsfNHc0AhBLdq45rnT87q/6O3vUEtNMafbhU6kt
hX7Y+9XFN9NpmYxr+ekVY5xOxi8h9JDIgoMP4VB1uS0aunL1IGqrNooL9mmFnL2k
LVVee6/VR6C5+KSTCMCWppMuJIZII2v9o4dkoZ8Y7QRjQlLfYzd3qGtKbw7xaF1U
sG/5xUb/Btwb2X2g4InpiB/yt/3CpQXpiWX/K4mBvUKiGn05ZsqeY1gx4g0xLBqc
U9psmyPzK+Vsgw2jeRQ5JlKDyqE0hebfC1tvFu0CCrJFcw==
-----END CERTIFICATE-----
`;

/**
 * Microsoft TPM Root Certificate Authority 2014.
 *
 * Root of trust for Windows-Hello TPM-backed platform-authenticator
 * attestation leaves. Byte-for-byte match of Microsoft's published
 * certificate at
 * https://www.microsoft.com/pkiops/certs/Microsoft%20TPM%20Root%20Certificate%20Authority%202014.crt.
 *
 * Note: Microsoft's Windows Hello attestation commonly uses `fmt: "tpm"`
 * rather than `fmt: "packed"`; this root is pinned for forward-compatibility
 * with Microsoft-signed `packed` leaves and for the TPM fmt's additive
 * arm (non-goal in v1).
 */
export const MICROSOFT_TPM_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIF9TCCA92gAwIBAgIQXbYwTgy/J79JuMhpUB5dyzANBgkqhkiG9w0BAQsFADCB
jDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1Jl
ZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjE2MDQGA1UEAxMt
TWljcm9zb2Z0IFRQTSBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSAyMDE0MB4X
DTE0MTIxMDIxMzExOVoXDTM5MTIxMDIxMzkyOFowgYwxCzAJBgNVBAYTAlVTMRMw
EQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVN
aWNyb3NvZnQgQ29ycG9yYXRpb24xNjA0BgNVBAMTLU1pY3Jvc29mdCBUUE0gUm9v
dCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgMjAxNDCCAiIwDQYJKoZIhvcNAQEBBQAD
ggIPADCCAgoCggIBAJ+n+bnKt/JHIRC/oI/xgkgsYdPzP0gpvduDA2GbRtth+L4W
UyoZKGBw7uz5bjjP8Aql4YExyjR3EZQ4LqnZChMpoCofbeDR4MjCE1TGwWghGpS0
mM3GtWD9XiME4rE2K0VW3pdN0CLzkYbvZbs2wQTFfE62yNQiDjyHFWAZ4BQH4eWa
8wrDMUxIAneUCpU6zCwM+l6Qh4ohX063BHzXlTSTc1fDsiPaKuMMjWjK9vp5UHFP
a+dMAWr6OljQZPFIg3aZ4cUfzS9y+n77Hs1NXPBn6E4Db679z4DThIXyoKeZTv1a
aWOWl/exsDLGt2mTMTyykVV8uD1eRjYriFpLQBFT0EfijJB0WzrVeJExDVBtH74E
1vV0zGlKn3IdmkoXMq72wBWmldvnWqMkYmG+/TT4VqsmxwYQKsW8pAmO2ouCXCq7
x8XFs2otDi4QZIc6HBxGe0GR8yxI/XxdFR3jGq0GmgcwBKJSNXOvbTS0Ql3TjfuJ
HO3+SM8ioybJMeAexjRPOGd9mZZdkns2awTW8lzxE2pi0iMsPALLmWekmQTxAkyo
h+mXxIdjICnsA+J5Nc2vB/YfM1v8Of8jlLSrkVZ+HjAJKaA3TwfnuL9yPalajgSs
AonA/aGPrpbFTJKnYsX6TAKpxvlLrNs/XZBERPFfygBJTffBMVoerIJQa+W5AgMB
AAGjUTBPMAsGA1UdDwQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR6
jArOL0hiF+KU0a5VwVLscXSkVjAQBgkrBgEEAYI3FQEEAwIBADANBgkqhkiG9w0B
AQsFAAOCAgEAW4ioo1+J9VWC0UntSBXcXRm1ePTVamtsxVy/GpP4EmJd3Ub53JzN
BfYdgfUL51CppS3ZY6BoagB+DqoA2GbSL+7sFGHBl5ka6FNelrwsH6VVw4xV/8kl
IjmqOyfatPYsz0sUdZev+reeiGpKVoXrK6BDnUU27/mgPtem5YKWvHB/soofUrLK
zZV3WfGdx9zBr8V0xb6n9YUTHRp/nmn5F4VWLBwyjjlRofFJuFZbM0S91aOu6hit
UOHsgEl6vTlc1v5ymG2tTRSZ+hVbazQWGF6cnKE0NYZy7UCjl2ZWN+FYHUX3tzrK
UXDy3jl6wmRy+R0O7CJjEgQsaa4Rkz/L+0mdCIdhTNijxPRTaPcLGn1l5ZxtqWl3
OdcbVjQGMnOWrkaxpbI99/C8tBiYuUCiPkCeuK+0wLMjP3b3zlPGjZnTVSgq52bK
7JIB70R8dnC6PIPjY9QeY5bOTQJ1LJ/h8Hcn4Vam0aZMIpWDjMOXK48rLNG1+mXB
oDpoa1jAD+hxi54GSJHgGtVHG/HEiBdpHumOBYDLv5UZ9T2nHhPbmkpTA5JvzaCT
Wb0B4htaAlVCbQ0Tn4mNHhASa/rsSpl0C5bpFggsDdaaRmcRJ3UPy+GmSZPT9Xsh
Hv7yoFFKi50iNfc59NhT2Qh/6V/8gK7U+rfcKk+KlW/2k+JSX+4Dyh8=
-----END CERTIFICATE-----
`;

/**
 * Default FIDO root accept-set. Full attestation (x5c present) must
 * chain to exactly one of these. Tests override by passing
 * `WebAuthnVerifyOptions.rootPems` — the runtime-injected set replaces
 * the pinned default so fabricated chains can exercise the same code
 * path.
 */
export const DEFAULT_FIDO_ROOTS: ReadonlyArray<string> = [
  APPLE_WEBAUTHN_ROOT_PEM,
  YUBICO_FIDO_ROOT_PEM,
  MICROSOFT_TPM_ROOT_PEM,
];

/**
 * WebAuthn attestation format discriminator the verifier accepts in v1.
 * `packed` is the broadest-coverage format and the only one v1 handles.
 * `tpm`, `android-key`, `android-safetynet`, `fido-u2f`, `apple`, and
 * `none` are rejected with a structured `fmt-not-supported` error.
 */
export const WEBAUTHN_FMT_PACKED = "packed";
