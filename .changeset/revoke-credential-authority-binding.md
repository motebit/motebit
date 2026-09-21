---
"@motebit/relay": patch
---

Credential revocation authorizes against the credential, not against a value the caller supplies.

`POST /api/v1/agents/:motebitId/revoke-credential` states the rule in its own refusal — "Only the credential subject or issuer can revoke" — but decided it with `callerMotebitId === motebitId`, where `motebitId` is the path segment. The credential named in the body was never compared to it. Naming yourself in the path therefore satisfied the subject test for any credential, including one held by someone else. The route's audience resolver matches `path.includes("/credentials")`, which does not match `revoke-credential`, so the route sits on the general `admin:query` audience an agent mints from its own key.

Authorization now resolves the credential first and binds to it: the subject test compares the caller to the row's `subject_motebit_id`, the issuer test compares the caller's DIDs to the row's `issuer_did`, and the path segment must name the credential's holder — it keeps the route's meaning honest, it does not authorize.

Two further corrections in the same handler:

- The issuer check read `devices[0]?.public_key`, and `listDevices` is `SELECT * FROM devices WHERE motebit_id = ?` with no `ORDER BY`. For an identity with several devices it consulted an arbitrary one, so a legitimate issuer whose issuing key sat in any other row was refused nondeterministically. It now checks every device of the caller.
- The revocation row recorded the path segment as its subject, so a revocation written by someone else was filed under whatever identity the request named. It records the credential's actual holder, and `revoked_by` names the requester.

An agent may no longer name a credential this relay does not hold — with no row there is no subject and no issuer, so there is nobody the caller could be, and permitting it is what allowed an identifier to be denied before it was ever issued. The operator's blocklist over an unheld identifier is unchanged and now has a test, so narrowing the agent path cannot silently remove it.

The rule had two tests before this change and neither reached it: one covers the no-token case, the other uses the operator master token, which sets no `callerMotebitId` and short-circuits the subject test. Every test added here mints a real signed device token.
