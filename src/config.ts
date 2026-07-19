/**
 * Loads and validates the indexer configuration into a fully-defaulted
 * config. Resolution order: explicit --config file, the `code-indexer`
 * field of the repo-root package.json, then `code-indexer.config.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** One indexed area of the repo, emitted as `<outDir>/<name>.md`. */
export interface TargetConfig {
  /** Repo-relative directory the target covers; paths in the index are relative to it. */
  base: string;
  /** Glob patterns (relative to `base`) that exclude a file from this target. */
  exclude: string[];
  /** Glob patterns (relative to `base`) a file must match to be indexed. */
  include: string[];
  /** Index file name (without extension) and display label. */
  name: string;
}

/** Fully-resolved indexer configuration with all defaults applied. */
export interface IndexerConfig {
  /** Files with more exports than this switch from one-line to one-symbol-per-line form. */
  blockThreshold: number;
  /** Glob patterns (relative to each target base) excluded from every target. */
  exclude: string[];
  /** File extensions eligible for indexing. */
  extensions: string[];
  /** Repo-relative directory the index files are written to. */
  outDir: string;
  targets: TargetConfig[];
}

export const DEFAULT_CONFIG_FILE = "code-indexer.config.json";
export const PACKAGE_JSON_CONFIG_KEY = "code-indexer";

const TRAILING_SLASHES = /\/+$/;

const DEFAULT_OUT_DIR = ".agents/index";
const DEFAULT_BLOCK_THRESHOLD = 10;
const DEFAULT_EXTENSIONS = [".ts", ".tsx"];
const DEFAULT_EXCLUDE = [
  "**/*.d.ts",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/*.gen.*",
];

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const asStringArray = (
  value: unknown,
  label: string,
  fallback: string[]
): string[] => {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
};

const asPositiveInteger = (
  value: unknown,
  label: string,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

const parseTarget = (value: unknown, position: number): TargetConfig => {
  const record = asRecord(value, `targets[${position}]`);
  const name = asString(record.name, `targets[${position}].name`);
  const base = asString(record.base, `targets[${position}].base`).replace(
    TRAILING_SLASHES,
    ""
  );
  return {
    name,
    base,
    include: asStringArray(record.include, `targets[${position}].include`, [
      "**",
    ]),
    exclude: asStringArray(record.exclude, `targets[${position}].exclude`, []),
  };
};

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Cannot read config from: ${filePath}`);
  }
};

/** Finds the raw (unvalidated) config value per the resolution order. */
const resolveRawConfig = (
  repoRoot: string,
  explicitPath: string | undefined
): unknown => {
  if (explicitPath) {
    return readJsonFile(explicitPath);
  }
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    const packageJson = asRecord(readJsonFile(packageJsonPath), "package.json");
    const embedded = packageJson[PACKAGE_JSON_CONFIG_KEY];
    if (embedded !== undefined) {
      return embedded;
    }
  }
  const standalonePath = path.join(repoRoot, DEFAULT_CONFIG_FILE);
  if (existsSync(standalonePath)) {
    return readJsonFile(standalonePath);
  }
  throw new Error(
    `No config found: add a "${PACKAGE_JSON_CONFIG_KEY}" field to package.json, create ${DEFAULT_CONFIG_FILE}, or pass --config <path>`
  );
};

/** Resolves, validates, and defaults the indexer configuration. */
export const loadConfig = (
  repoRoot: string,
  explicitPath: string | undefined
): IndexerConfig => {
  const root = asRecord(resolveRawConfig(repoRoot, explicitPath), "config");
  if (!Array.isArray(root.targets) || root.targets.length === 0) {
    throw new Error("config.targets must be a non-empty array");
  }
  const targets = root.targets.map((target, position) =>
    parseTarget(target, position)
  );
  const seenNames = new Set<string>();
  for (const target of targets) {
    if (seenNames.has(target.name)) {
      throw new Error(`Duplicate target name in config: ${target.name}`);
    }
    seenNames.add(target.name);
  }
  return {
    outDir:
      root.outDir === undefined
        ? DEFAULT_OUT_DIR
        : asString(root.outDir, "config.outDir"),
    blockThreshold: asPositiveInteger(
      root.blockThreshold,
      "config.blockThreshold",
      DEFAULT_BLOCK_THRESHOLD
    ),
    extensions: asStringArray(
      root.extensions,
      "config.extensions",
      DEFAULT_EXTENSIONS
    ),
    exclude: asStringArray(root.exclude, "config.exclude", DEFAULT_EXCLUDE),
    targets,
  };
};
