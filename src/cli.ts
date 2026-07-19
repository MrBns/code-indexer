#!/usr/bin/env node
/**
 * code-indexer CLI — generates greppable per-target indexes of every
 * exported symbol in a TypeScript repo, for AI-agent code navigation.
 *
 * Modes:
 *   full-scan  rebuild every index file from all tracked files
 *   git-diff   patch index files using only the currently staged changes
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_CONFIG_FILE,
  type IndexerConfig,
  loadConfig,
  PACKAGE_JSON_CONFIG_KEY,
  type TargetConfig,
} from "./config.ts";
import {
  fileMatchesTarget,
  listStagedChanges,
  listTargetFiles,
  relativePathInTarget,
  resolveRepoRoot,
  type StagedChange,
} from "./discover.ts";
import { buildRecordLines, parseIndexContent, renderIndex } from "./emit.ts";
import { extractFileSummary } from "./extract.ts";

const HELP_TEXT = `code-indexer — greppable exported-symbol indexes for TypeScript repos

Usage:
  code-indexer full-scan [options]   rebuild every index file from scratch
  code-indexer git-diff  [options]   update index files from staged changes only

Options:
  --config <path>  config file (default: "${PACKAGE_JSON_CONFIG_KEY}" field in package.json, or ${DEFAULT_CONFIG_FILE})
  --out <dir>      output directory override (default: config outDir, .agents/index)
  -h, --help       show this help
`;

const indexFilePathFor = (
  repoRoot: string,
  outDir: string,
  target: TargetConfig
): string => path.join(repoRoot, outDir, `${target.name}.md`);

const buildRecordFor = (
  repoRoot: string,
  relativePath: string,
  target: TargetConfig,
  config: IndexerConfig
): string[] => {
  const absolutePath = path.join(repoRoot, target.base, relativePath);
  return buildRecordLines(
    relativePath,
    extractFileSummary(absolutePath),
    config.blockThreshold
  );
};

const fullScanTarget = (
  repoRoot: string,
  outDir: string,
  target: TargetConfig,
  config: IndexerConfig
): number => {
  const records = new Map<string, string[]>();
  for (const repoPath of listTargetFiles(repoRoot, target, config)) {
    const relativePath = relativePathInTarget(repoPath, target);
    if (
      relativePath === undefined ||
      !existsSync(path.join(repoRoot, repoPath))
    ) {
      continue;
    }
    records.set(
      relativePath,
      buildRecordFor(repoRoot, relativePath, target, config)
    );
  }
  writeFileSync(
    indexFilePathFor(repoRoot, outDir, target),
    renderIndex(target, records)
  );
  return records.size;
};

const runFullScan = (
  repoRoot: string,
  outDir: string,
  config: IndexerConfig
): void => {
  for (const target of config.targets) {
    const fileCount = fullScanTarget(repoRoot, outDir, target, config);
    process.stdout.write(`${target.name}.md — ${fileCount} files indexed\n`);
  }
};

const patchTarget = (
  repoRoot: string,
  outDir: string,
  target: TargetConfig,
  config: IndexerConfig,
  changes: StagedChange[]
): void => {
  const relevantChanges = changes.filter(
    (change) => relativePathInTarget(change.path, target) !== undefined
  );
  if (relevantChanges.length === 0) {
    return;
  }
  const indexFile = indexFilePathFor(repoRoot, outDir, target);
  // Without an existing index there is nothing to patch — build it fully.
  if (!existsSync(indexFile)) {
    const fileCount = fullScanTarget(repoRoot, outDir, target, config);
    process.stdout.write(
      `${target.name}.md — created (${fileCount} files indexed)\n`
    );
    return;
  }
  const records = parseIndexContent(readFileSync(indexFile, "utf8"));
  let updatedCount = 0;
  let removedCount = 0;
  for (const change of relevantChanges) {
    const relativePath = relativePathInTarget(change.path, target);
    if (relativePath === undefined) {
      continue;
    }
    const isIndexable =
      !change.deleted &&
      fileMatchesTarget(change.path, target, config) &&
      existsSync(path.join(repoRoot, change.path));
    if (isIndexable) {
      records.set(
        relativePath,
        buildRecordFor(repoRoot, relativePath, target, config)
      );
      updatedCount += 1;
    } else if (records.delete(relativePath)) {
      removedCount += 1;
    }
  }
  if (updatedCount === 0 && removedCount === 0) {
    return;
  }
  writeFileSync(indexFile, renderIndex(target, records));
  process.stdout.write(
    `${target.name}.md — ${updatedCount} updated, ${removedCount} removed\n`
  );
};

const runGitDiff = (
  repoRoot: string,
  outDir: string,
  config: IndexerConfig
): void => {
  const changes = listStagedChanges(repoRoot);
  if (changes.length === 0) {
    process.stdout.write("No staged changes — indexes untouched\n");
    return;
  }
  for (const target of config.targets) {
    patchTarget(repoRoot, outDir, target, config, changes);
  }
};

const main = (): void => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const mode = positionals[0];
  if (mode !== "full-scan" && mode !== "git-diff") {
    process.stderr.write(HELP_TEXT);
    throw new Error(
      `Expected mode "full-scan" or "git-diff", got: ${mode ?? "(none)"}`
    );
  }
  const repoRoot = resolveRepoRoot();
  const config = loadConfig(
    repoRoot,
    values.config ? path.resolve(values.config) : undefined
  );
  const outDir = values.out ?? config.outDir;
  mkdirSync(path.join(repoRoot, outDir), { recursive: true });
  if (mode === "full-scan") {
    runFullScan(repoRoot, outDir, config);
    return;
  }
  runGitDiff(repoRoot, outDir, config);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`code-indexer: ${message}\n`);
  process.exitCode = 1;
}
