# AGENTS.md — @mrbns/code-indexer

Orientation for AI agents (and humans) working on or with this package.

## What this package is

A zero-dependency CLI (`code-indexer`) that generates **greppable indexes of
every exported symbol** in a TypeScript repository, one markdown file per
configured target, written to `.agents/index/` by default.

## Why it was created

AI coding agents navigate repositories by searching (`rg`, `ast-grep`) and
reading files. Without a map, every task starts with exploratory directory
walks and wrong-file reads — tokens and time spent rediscovering the same
structure. Embedding/vector indexes are the common answer, but below ~1M LOC
they are the wrong tool: they go stale on every commit, need infrastructure,
and lose to exact lexical search on precise identifiers.

## The problem it solves

It gives an agent the repo's **public surface as one cheap read**: for any
"where does X live" question, the agent reads (or greps) one index file and
opens exactly the right source file, instead of exploring. The index is a
table of contents, not a replacement for reading source — ground truth stays
in the code.

## How it works

Deterministic extraction, no LLM anywhere in the pipeline:

1. **Discover** ([src/discover.ts](src/discover.ts)) — asks git for files
   (`git ls-files` for full scans, `git diff --cached` for staged changes),
   filters them through per-target include/exclude globs. Only **tracked**
   files are indexed; new files enter the index when first staged.
2. **Extract** ([src/extract.ts](src/extract.ts)) — parses each file with the
   TypeScript compiler's parser only (`ts.createSourceFile`; no program, no
   type checker), collects exported declarations and the first JSDoc line.
3. **Emit** ([src/emit.ts](src/emit.ts)) — renders records and incrementally
   patches existing index files by path prefix.
4. **CLI** ([src/cli.ts](src/cli.ts)) — two modes: `full-scan` (rebuild
   everything) and `git-diff` (patch from staged changes; meant for
   pre-commit hooks). Config loading lives in [src/config.ts](src/config.ts).

Determinism is a contract: same source in, same index out — full-scan and
git-diff converge on byte-identical output, so CI can verify freshness with
`git diff --exit-code`.

## Output format (and why)

Each index file: YAML frontmatter (target metadata) → H1 title (markdown
lint requires a first-line heading) → raw record lines.

- Files with ≤ `blockThreshold` (default 10) exports: one line —
  `path | kind name, kind name | first JSDoc line`.
- Files above the threshold: a summary line plus **one line per symbol, each
  repeating the path**. This bounds line length, keeps git diffs and merges
  one-line-per-change on high-churn files (types/dto/validators), and keeps
  every grep hit self-contained. The repetition tax is paid only by the few
  fat files that need it.
- Only **exported** symbols appear — local variables and private helpers are
  not navigation targets; agents meet them when they open the file, which
  they must do before editing anyway. No caps, no truncation: a truncated
  index lies, and a wrong index is worse than none.
- Descriptions are **harvested** from the first JSDoc line of a file's
  exports — never required, never generated.

## Config decisions

Resolution order (first match wins):

1. `--config <path>` CLI flag — explicit always wins.
2. `.config/code-indexer.json` — the dot-config directory convention, for
   repos that keep tool configs out of the root.
3. A `"code-indexer"` field in `package.json`, then `deno.json` — either an
   **inline config object** or a **string path** to a JSON config file
   (resolved from the repo root). `deno.jsonc` is not supported (comments
   don't survive `JSON.parse`).

Rationale: the tool must not force a new root-level config file on a repo
(config-file sprawl was an explicit objection from its first user). Inline
manifest config is the default posture; the dot-config file exists for repos
that prefer directory-scoped configs; the string-path form covers everyone
else. Only `targets` is required — `outDir` (`.agents/index`),
`blockThreshold` (10), `extensions` (`.ts`/`.tsx`), and `exclude`
(d.ts/tests/specs/`__tests__`/`.gen.*`) all have defaults. See README for
the full schema.

## Working on this package

- `pnpm build` — bundles with tsdown to `dist/cli.mjs`, which is what the
  `bin` points at. For local dev without a build, run `node src/cli.ts`
  directly (Node ≥ 23.6 type-stripping). Do NOT point `bin` at `src/cli.ts`:
  npm consumers can't run TypeScript from node_modules (v0.1.0 shipped
  broken exactly this way), and `publishConfig.bin` overrides only apply
  with `pnpm publish` — not `npm publish`.
- `pnpm check-types` — `tsc --noEmit`.
- Keep the source **erasable-syntax only** (no enums/namespaces) so it stays
  runnable via Node type-stripping.
- Zero runtime dependencies except `typescript` itself. Keep it that way —
  it is what makes the tool trivially adoptable.
- Requires git; all file discovery goes through it deliberately (respects
  tracking status, powers the staged-diff incremental mode).
