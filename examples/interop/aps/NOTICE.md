# Vendored third-party fixture

`case-a-neutral-vector.CANDIDATE.json` is copied unmodified from
[agent-passport-system/aps-openshell-reference-middleware](https://github.com/agent-passport-system/aps-openshell-reference-middleware)
at commit `2508f6a7`, path `vector/case-a-neutral-vector.CANDIDATE.json`.

- **License:** Apache License 2.0, © its authors. The full license text, copied from upstream at
  `2508f6a7`, is [`LICENSE`](LICENSE) in this directory. It covers the vendored vector only; it is
  not a Motebit license.
- **SHA-256:** `4918125741234d749e4ab23cb6ec98c12f6b86b951147eca984b04a76bb53d31`
- **Status upstream:** a CANDIDATE vector, not an admitted conformance fixture.
- **Signing construction:** draft-pidlisnyi-aps-04 §4.1.

Motebit's consumer test verifies this file with Motebit's own code; it imports no APS code.
Discussion: motebit/motebit#22.

## Upstream NOTICE

Carried over verbatim from `NOTICE` at upstream commit `2508f6a7` (Apache-2.0 §4(d)). It describes
the upstream repository as a whole; the only file vendored here is the vector above.

```text
APS OpenShell reference enforcement middleware
Copyright 2026 Tymofii Pidlisnyi (Agent Passport System)

This product is licensed under the Apache License, Version 2.0 (see LICENSE).

It includes proto files copied verbatim from NVIDIA/OpenShell
(https://github.com/NVIDIA/OpenShell) at commit
ba16b9f2c7c59899532628ffa6cd26d37bffd477, under the Apache License,
Version 2.0, with their SPDX headers preserved:
  proto/supervisor_middleware.proto
  proto/extension.proto
Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES.

harness/openshell-harness.patch adds test code to a local OpenShell checkout.
It is not part of OpenShell and has not been offered to or reviewed by NVIDIA.
```
