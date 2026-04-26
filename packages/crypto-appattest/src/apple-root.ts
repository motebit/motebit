/**
 * Pinned Apple App Attest root certificate.
 *
 * This PEM is the root of trust for every `platform: "device_check"`
 * hardware-attestation claim. Pinning is the self-attesting contract
 * — a verifier that dynamically fetched the Apple CA would have no
 * sovereign story, because a third party auditing our output could
 * never reproduce the decision without trusting our fetch path. By
 * committing the exact bytes of the CA we accept, anyone can audit
 * this file, pin the same bytes in their own verifier, and reach the
 * same yes/no answer.
 *
 * Source: Apple's published App Attest CA (Apple App Attestation Root
 * CA). SHA-256 fingerprint of this certificate is the attestor the
 * chain-verification routine requires the leaf's intermediate CA to
 * chain to.
 *
 * If Apple rotates this root (they have every right to — they publish
 * rotation schedules in their developer documentation), an additive
 * PEM constant and a dispatch arm on expiry date land here. That's a
 * judgment call; it belongs in BSL with the rest of the chain-validation
 * policy.
 */

/**
 * Apple App Attestation Root CA — the single pinned anchor this package
 * chains App Attest leaves to.
 *
 *   Source:     https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 *   Subject:    CN=Apple App Attestation Root CA, O=Apple Inc., ST=California
 *   SHA-256:    1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932
 *   Public key: ECDSA P-384
 *   Validity:   2020-03-18 → 2045-03-15
 *
 * Byte-for-byte match of Apple's published certificate. The fingerprint
 * is the audit anchor — a third party that fetches the same Apple URL
 * and computes its own SHA-256 should reach the byte-identical value
 * above. Drift caught by `__tests__/apple-root.test.ts`.
 */
export const APPLE_APPATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

/**
 * Apple's published App Attest production RP ID / bundle-check domain.
 * Not used directly by this package — the consumer passes its own
 * bundle ID, which the verifier hashes and asserts equals the
 * authData.rpIdHash field. Exposed here as a labeled constant so the
 * audit trail is obvious.
 */
export const APPLE_APPATTEST_FMT = "apple-appattest";
