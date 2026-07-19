/**
 * File discovery: asks git which files exist (full scan) or changed (staged
 * diff), and filters them against target include/exclude globs.
 */
import { execFileSync } from "node:child_process";
import type { IndexerConfig, TargetConfig } from "./config.ts";

const GIT_BUFFER_BYTES = 64 * 1024 * 1024;

const runGit = (repoRoot: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_BUFFER_BYTES,
  });

/** Absolute path of the enclosing git repository root. */
export const resolveRepoRoot = (): string =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();

const REGEX_SPECIALS = new Set([
  "\\",
  "^",
  "$",
  ".",
  "|",
  "+",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
]);

/**
 * Converts a minimal glob (`**`, `*`, `?`) to a RegExp matched against
 * slash-separated relative paths. `**` crosses directory boundaries;
 * `*` and `?` do not.
 */
const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 2;
        if (pattern[index] === "/") {
          index += 1;
        }
      } else {
        source += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += REGEX_SPECIALS.has(char) ? `\\${char}` : char;
    index += 1;
  }
  return new RegExp(`^${source}$`);
};

const globRegExpCache = new Map<string, RegExp>();

const globRegExp = (pattern: string): RegExp => {
  const cached = globRegExpCache.get(pattern);
  if (cached) {
    return cached;
  }
  const compiled = globToRegExp(pattern);
  globRegExpCache.set(pattern, compiled);
  return compiled;
};

const matchesAny = (relativePath: string, patterns: string[]): boolean =>
  patterns.some((pattern) => globRegExp(pattern).test(relativePath));

/** Path of `repoPath` relative to the target base, or undefined if outside it. */
export const relativePathInTarget = (
  repoPath: string,
  target: TargetConfig
): string | undefined =>
  repoPath.startsWith(`${target.base}/`)
    ? repoPath.slice(target.base.length + 1)
    : undefined;

/** Whether a repo-relative file path belongs in the given target's index. */
export const fileMatchesTarget = (
  repoPath: string,
  target: TargetConfig,
  config: IndexerConfig
): boolean => {
  const relativePath = relativePathInTarget(repoPath, target);
  if (relativePath === undefined) {
    return false;
  }
  if (
    !config.extensions.some((extension) => relativePath.endsWith(extension))
  ) {
    return false;
  }
  if (matchesAny(relativePath, config.exclude)) {
    return false;
  }
  if (target.exclude.length > 0 && matchesAny(relativePath, target.exclude)) {
    return false;
  }
  return matchesAny(relativePath, target.include);
};

/** All tracked files belonging to the target, as repo-relative paths. */
export const listTargetFiles = (
  repoRoot: string,
  target: TargetConfig,
  config: IndexerConfig
): string[] => {
  const output = runGit(repoRoot, ["ls-files", "-z", "--", target.base]);
  return output
    .split("\0")
    .filter(
      (repoPath) =>
        repoPath.length > 0 && fileMatchesTarget(repoPath, target, config)
    );
};

/** One staged change; renames produce a deletion of the old path plus an upsert of the new. */
export interface StagedChange {
  deleted: boolean;
  path: string;
}

/** Parses `git diff --cached --name-status -z` into per-path changes. */
export const listStagedChanges = (repoRoot: string): StagedChange[] => {
  const output = runGit(repoRoot, ["diff", "--cached", "--name-status", "-z"]);
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const changes: StagedChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusCode = (tokens[index] ?? "").charAt(0);
    // Renames and copies carry two paths: the source, then the destination.
    if (statusCode === "R" || statusCode === "C") {
      const sourcePath = tokens[index + 1];
      const destinationPath = tokens[index + 2];
      if (statusCode === "R" && sourcePath) {
        changes.push({ path: sourcePath, deleted: true });
      }
      if (destinationPath) {
        changes.push({ path: destinationPath, deleted: false });
      }
      index += 3;
      continue;
    }
    const changedPath = tokens[index + 1];
    if (changedPath) {
      changes.push({ path: changedPath, deleted: statusCode === "D" });
    }
    index += 2;
  }
  return changes;
};
