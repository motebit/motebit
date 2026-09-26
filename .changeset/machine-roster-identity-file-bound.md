---
"motebit": patch
---

The machine roster takes evidence from a local `motebit.md` only when the key this machine holds signed it (#800).

`motebit machines`, the mint step at `motebit run` / `motebit serve`, and the rotation hook read `motebit.md` from the working directory and every parent directory. Before this fix, any self-signed file naming this motebit counted: a file planted in a parent directory, signed by an unrelated key and naming a guardian, could make the machine's key look like the identity key, show a count, and have a retirement signed and presented. A file now contributes succession records, and its guardian, only when its signature verifies, it names this motebit, and its current key is exactly the key in hand. Any other file contributes nothing. The rotation hook reads the new link only from a file whose current key is the committed key.
