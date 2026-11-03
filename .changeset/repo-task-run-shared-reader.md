---
"motebit": patch
---

`motebit repo-task run` reads the repository through `@motebit/verify/git`, the reader `motebit-verify repo-change` uses in CI, instead of a copy of its own: the isolated git session, the tip resolution, the tree reads, the pins, revocations and path policy at the tip, and the spent check. Its self-check now computes the verifier's inputs with the same function CI runs (`computeRepoChangeInputs`, base = the tip, head = the bundle commit), from the committed bundle rather than the bytes in memory. Behaviour is otherwise unchanged: every preflight refusal reads as before.
