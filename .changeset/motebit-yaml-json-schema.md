---
"motebit": minor
---

Publish `motebit-yaml-v1.json` — the JSON Schema for `motebit.yaml` is now
a committed protocol artifact at `apps/cli/schema/motebit-yaml-v1.json`,
generated from the same zod source the CLI parser and LSP consume.

Third-party validators (VS Code's Red Hat YAML extension, CI actions,
the dashboard) can reference it via its stable `$id` — no `motebit`
install required. Users who want an inline yaml-language-server pragma:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json
version: 1
# ...
```

New subcommand `motebit schema` emits the same schema to stdout for
vendoring into air-gapped workspaces. Drift defense #21 regenerates the
schema in-process on every test run and fails CI if the committed file
has drifted from the zod source.
