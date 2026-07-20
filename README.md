# @mrbns/code-indexer

Generates greppable per-target indexes of every **exported** symbol in a
TypeScript repo. Built so AI coding agents can find the right file in one
index read + one grep instead of exploring directories.

Deterministic — extraction uses the TypeScript parser only (no LLM, no type
checker), so the same source always produces the same index and CI can
verify freshness with `git diff --exit-code`.

## Usage

```sh
code-indexer full-scan   # rebuild every index file from all tracked files
code-indexer git-diff    # patch indexes using only the staged changes (for pre-commit hooks)

# options
code-indexer full-scan --config ./code-indexer.config.json --out .agents/index
```

Requires git (files are discovered via `git ls-files` / `git diff --cached`).
Only tracked files are indexed: brand-new files enter the index when first
staged (the pre-commit `git-diff` mode picks them up), never while untracked.

## Config

Resolution order (first match wins):

1. `--config <path>` CLI flag
2. `.config/code-indexer.json` at the repo root (dot-config convention) —
   contains the config object directly; the `"code-indexer"` wrapper key is
   only for manifest files
3. A `"code-indexer"` field in `package.json`, then `deno.json` — either an
   **inline config object** or a **string path** to a JSON config file
   (relative to the repo root; `deno.jsonc` is not supported)

No dedicated config file is needed — a manifest field is enough:

```json
{
  "code-indexer": {
    "targets": [
      { "name": "server", "base": "apps/server/src" },
      { "name": "website", "base": "apps/website", "include": ["app/**", "lib/**"] }
    ]
  }
}
```

Or point the field at a file instead: `"code-indexer": "./configs/indexer.json"`.

All other fields are optional (defaults shown):

```json
{
  "outDir": ".agents/index",
  "blockThreshold": 10,
  "extensions": [".ts", ".tsx"],
  "exclude": ["**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.gen.*"]
}
```

- `targets` (required) — each becomes `<outDir>/<name>.md`; index paths are
  relative to `base`. `include`/`exclude` are globs (`**`, `*`, `?`) relative
  to `base`; `include` defaults to everything.
- `outDir` — default `.agents/index`.
- `blockThreshold` — files with more exports than this switch from
  one-line-per-file to one-line-per-symbol form (default `10`).
- `exclude` — applies to every target; shown above are the defaults.

## Index format

Each index file is YAML frontmatter (target name, base path, format,
regenerate commands), an H1 title, then raw record lines — lint-clean
markdown with no other markup. Every record line starts with a `<path> |`
prefix, so grep hits are always self-contained:

```text
modules/cart/service.ts | fn addToCart, fn removeItem | Cart line-item operations
modules/products/types.ts | 42 exports | Product domain types
modules/products/types.ts | type Product
modules/products/types.ts | type ProductVariant
```

Only exported symbols are indexed (`export const` counts; local variables and
private helpers never appear). Re-exports are summarized as `* from ./x`
rather than expanded. The description column is harvested from the first
JSDoc line among a file's exports — optional, never required.

## Pre-commit (lefthook example)

```yaml
pre-commit:
  jobs:
    - name: Updating code index
      glob: "*.{ts,tsx}"
      run: pnpm exec code-indexer git-diff && git add .agents/index
```
