/**
 * Renders and re-parses index files. Each file is YAML frontmatter
 * (target metadata), an H1 title, then raw record lines. Every record line starts
 * with a `<path> | ` prefix, so a file's record is the contiguous group of
 * lines sharing that path — the property incremental patching relies on.
 */
import type { TargetConfig } from "./config.ts";
import type { FileSummary } from "./extract.ts";

const entryParts = (summary: FileSummary): string[] =>
  summary.entries.map((entry) =>
    entry.kind === "reexport" ? entry.name : `${entry.kind} ${entry.name}`
  );

/**
 * Builds the index lines for one source file. Files at or below
 * `blockThreshold` exports get a single line; larger files get a summary
 * line followed by one line per symbol, each repeating the path so every
 * grep hit stays self-contained.
 */
export const buildRecordLines = (
  relativePath: string,
  summary: FileSummary,
  blockThreshold: number
): string[] => {
  const parts = entryParts(summary);
  const descriptionSuffix = summary.description
    ? ` | ${summary.description}`
    : "";
  if (parts.length === 0) {
    return [`${relativePath} | (no exports)${descriptionSuffix}`];
  }
  if (parts.length <= blockThreshold) {
    return [`${relativePath} | ${parts.join(", ")}${descriptionSuffix}`];
  }
  const lines = [
    `${relativePath} | ${parts.length} exports${descriptionSuffix}`,
  ];
  for (const part of parts) {
    lines.push(`${relativePath} | ${part}`);
  }
  return lines;
};

/** Renders a complete index file: header, then records sorted by path. */
export const renderIndex = (
  target: TargetConfig,
  records: Map<string, string[]>
): string => {
  const headerLines = [
    "---",
    `target: ${target.name}`,
    `base: ${target.base}/`,
    'format: "<path> | <exports> | <first JSDoc line>"',
    'generated-by: "@mrbns/code-indexer — do not edit by hand"',
    'regenerate: "code-indexer full-scan | code-indexer git-diff (staged only)"',
    "---",
    "",
    `# ${target.name} — code symbol index`,
    "",
  ];
  const sortedPaths = [...records.keys()].sort((left, right) =>
    left < right ? -1 : 1
  );
  const bodyLines: string[] = [];
  for (const recordPath of sortedPaths) {
    bodyLines.push(...(records.get(recordPath) ?? []));
  }
  return [...headerLines, ...bodyLines, ""].join("\n");
};

/**
 * Parses an existing index file back into path → record lines. The whole
 * frontmatter block is skipped, so header values that contain " | " (like
 * the format description) are never mistaken for records.
 */
export const parseIndexContent = (content: string): Map<string, string[]> => {
  const records = new Map<string, string[]>();
  const lines = content.split("\n");
  let bodyStart = 0;
  if (lines[0] === "---") {
    const closingIndex = lines.indexOf("---", 1);
    bodyStart = closingIndex < 0 ? lines.length : closingIndex + 1;
  }
  for (const line of lines.slice(bodyStart)) {
    if (line.length === 0) {
      continue;
    }
    const separatorIndex = line.indexOf(" | ");
    if (separatorIndex < 0) {
      continue;
    }
    const recordPath = line.slice(0, separatorIndex);
    const existing = records.get(recordPath);
    if (existing) {
      existing.push(line);
    } else {
      records.set(recordPath, [line]);
    }
  }
  return records;
};
