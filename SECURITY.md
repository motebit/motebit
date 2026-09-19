# Security Policy

## Reporting a vulnerability

**Do not file a public issue.** Email **security@motebit.com** with:

- Description of the vulnerability
- Steps to reproduce
- Affected package or file path
- Impact assessment (what an attacker could do)

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

## Scope

Motebit handles cryptographic key material, identity tokens, and privacy-sensitive memory. We take all security reports seriously, especially:

- Cryptographic weaknesses (key derivation, signing, encryption)
- Authentication or authorization bypass
- Private key exposure or leakage
- Policy gate bypass (tool approval circumvention)
- Injection attacks (prompt injection, SQL injection, XSS)
- Memory or event data exposure across motebit boundaries

## Responsible disclosure

We ask that you give us reasonable time to address the issue before public disclosure. We will credit reporters in the fix commit unless you prefer to remain anonymous.

## What we disclose

The request above runs both ways. When we fix a weakness in our own code — whether it was reported to us or we found it ourselves — we record it in [`SECURITY-DISCLOSURES.md`](SECURITY-DISCLOSURES.md): what the code did, who could have exploited it, which release carries the fix, and what we checked afterwards, including what that check could not see. Weaknesses we have found and not yet closed are tracked as public issues, without the detail that would help someone use them before we do.

A weakness in a published package gets an advisory as well, so its users know which version to move off. A weakness in a service we operate gets this record, because there is no version for anyone to move off and a notice that cannot be acted on is not a disclosure.

This is the same posture the relay takes with its own observability — declared in [`services/relay/PRIVACY.md`](services/relay/PRIVACY.md), proven against the signed transparency declaration — applied to our mistakes rather than our data handling. See [`docs/doctrine/operator-transparency.md`](docs/doctrine/operator-transparency.md).
