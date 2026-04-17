# motebit.yaml JSON Schema

`motebit-yaml-v1.json` is the public JSON Schema for [`motebit.yaml`](../../../README.md) — the
declarative surface applied by `motebit up`. It is generated from the
zod schema in `apps/cli/src/yaml-config.ts` by running
`pnpm --filter motebit build-schema`; drift-defense #21 pins the two
in sync.

## Using the schema

### VS Code + Cursor (via the Red Hat YAML extension)

Add to your workspace `settings.json`:

```json
{
  "yaml.schemas": {
    "https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json": "motebit.yaml"
  }
}
```

Or add a pragma at the top of `motebit.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json
version: 1
```

_Note:_ installing [`@motebit/vscode`](../../vscode) gives you the full LSP
experience (diagnostics, hover, completion). The JSON Schema route is for
environments where you don't want the full extension — pure validation only.

### NeoVim / Vim (via yaml-language-server)

Register the schema in your `yaml-language-server` config or add the
`$schema` pragma above.

### JetBrains

`Preferences → Languages & Frameworks → Schemas and DTDs → JSON Schema
Mappings → Add`, then point the schema URL at the raw GitHub URL above
and the file pattern at `motebit.yaml`.

### Air-gapped / local

Vendor the schema into your project:

```sh
motebit schema > .motebit/motebit-yaml.schema.json
```

then reference the local path instead of the GitHub URL.

## Regenerating

After editing `apps/cli/src/yaml-config.ts`:

```sh
pnpm --filter motebit build-schema
git add apps/cli/schema/motebit-yaml-v1.json
```

The drift test (`apps/cli/src/__tests__/yaml-json-schema.test.ts`) fails
CI if the committed file does not match the live zod schema — the
failure message states the exact fix.
