---
"motebit": patch
---

`motebit repo-task run` takes `--author "Name <email>"`, the git author and committer of both commits. The default is unchanged. A repository whose required checks read the commit identity (a CLA check links the email to an account) can now take a governed change: with the default, unlinked identity, such a check cannot pass. Who acted is still the signed bundle's to say, never the git author's. A malformed value is refused before the first model call.
