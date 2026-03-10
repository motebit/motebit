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
