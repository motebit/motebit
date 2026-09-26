---
"motebit": patch
---

The machine roster stops re-presenting an entry the relay will never hold (#802).

A relay refuses a presented entry for its own bytes as `too_large`, `malformed`, `wrong_motebit` or `bad_signature`. Before this fix, every such refusal was treated as "not taken": the entry was presented again on every start and every `motebit machines`, the count was suppressed as if the relay were omitting it, and the message said it would be "presented again". Those refusals are now permanent, like `roster_full`. The entry is kept on this device with the relay's reason, reported once ("The relay will not hold this enrolment: too_large; kept on this device only, not presented again."), and never presented again. It stays a member: `motebit machines` counts it and adds a note that the relay will not hold it. A refusal reason the CLI does not know is still retried.

An entry larger than a relay holds (4096 bytes of canonical JSON) is now presented on its own, so it can no longer make the relay refuse a whole request (413) and take the other entries with it. `motebit machines enroll <id> --force` refuses an id whose enrolment would pass that bound ("Not enrolled: the entry for … would be N bytes; a relay holds at most 4096."), and nothing is kept.
