# Governance

## Decision-making

Motebit is maintained by [Daniel Hakim](https://github.com/hakimlabs) at Motebit, Inc. All architectural decisions, release approvals, and roadmap priorities are made by the maintainer.

This is a single-maintainer project. As the project grows, contributor roles and an RFC process for implementation proposals may be introduced. Architectural authority — the design thesis, the constraint documents, the layer structure, and the licensing model — remains with the maintainer.

## Contributions

All contributions are welcome through pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the process.

Contributors do not gain commit access or decision-making authority by default. Consistent, high-quality contributions over time may lead to expanded roles as the project matures.

## Licensing decisions

The dual-license structure (BSL 1.1 for the platform, Apache-2.0 for the permissive floor) is a deliberate architectural decision. The protocol must be open for adoption, and the Apache-2.0 patent grant matters because the floor verifies against patent-active platforms (Apple, Google, TPM vendors, FIDO). The platform implementation is protected to sustain development. Each BSL-licensed version converts to Apache-2.0 after 4 years — both license families converge to Apache-2.0 in the end state.

Changes to the licensing structure are made solely by the maintainer.

## Principles

The principles those decisions serve are articulated in [`CONSTITUTION.md`](CONSTITUTION.md) — one being, consent-first autonomy, open standard / proprietary product, and what compounds. Every architectural call passes through the test it names: _does this serve the one-being model?_

## Roadmap

The roadmap is driven by [`CONSTITUTION.md`](CONSTITUTION.md), the design-thesis documents ([`DROPLET.md`](DROPLET.md), [`THE_SOVEREIGN_INTERIOR.md`](THE_SOVEREIGN_INTERIOR.md)), and the technical architecture in [`CLAUDE.md`](CLAUDE.md). Feature requests and community input inform priorities but do not determine them.

## Code of Conduct

All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Enforcement decisions are made by the maintainer.
