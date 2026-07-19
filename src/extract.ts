/**
 * Extracts the exported-symbol surface of a single TypeScript source file
 * using the compiler's parser only — no program, no type checker.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

/** One exported symbol; `kind` is a short label such as `fn`, `class`, `type`. */
export interface ExportEntry {
  kind: string;
  name: string;
}

/** Export surface of one file plus its first JSDoc summary line, if any. */
export interface FileSummary {
  description: string | undefined;
  entries: ExportEntry[];
}

const MAX_DESCRIPTION_LENGTH = 120;
const WHITESPACE_RUN = /\s+/g;

/** Collapses whitespace, strips the field separator, and bounds the length. */
const sanitizeDescription = (raw: string): string => {
  const collapsed = raw
    .replace(WHITESPACE_RUN, " ")
    .replaceAll("|", "/")
    .trim();
  if (collapsed.length <= MAX_DESCRIPTION_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
};

/** First line of the first JSDoc block attached to the node, if any. */
const firstJsDocLine = (node: ts.Node): string | undefined => {
  for (const doc of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(doc)) {
      continue;
    }
    const text = ts.getTextOfJSDocComment(doc.comment);
    if (!text) {
      continue;
    }
    const line = text.split("\n")[0]?.trim();
    if (line) {
      return sanitizeDescription(line);
    }
  }
  return;
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === kind
  );
};

const isExported = (node: ts.Node): boolean =>
  hasModifier(node, ts.SyntaxKind.ExportKeyword);

const isDefaultExport = (node: ts.Node): boolean =>
  hasModifier(node, ts.SyntaxKind.DefaultKeyword);

/** Flattens an identifier or (possibly nested) binding pattern into names. */
const bindingNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    names.push(...bindingNames(element.name));
  }
  return names;
};

const variableKind = (
  declaration: ts.VariableDeclaration,
  isConst: boolean
): string => {
  const initializer = declaration.initializer;
  if (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return "fn";
  }
  return isConst ? "const" : "let";
};

const declarationEntries = (
  statement: ts.Statement,
  kind: string,
  name: string | undefined
): ExportEntry[] => {
  if (!isExported(statement)) {
    return [];
  }
  const resolvedKind = isDefaultExport(statement) ? "default" : kind;
  return [{ kind: resolvedKind, name: name ?? "(anonymous)" }];
};

const variableStatementEntries = (
  statement: ts.VariableStatement
): ExportEntry[] => {
  if (!isExported(statement)) {
    return [];
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: NodeFlags is a bitflag enum; & is the compiler API's intended check.
  const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  const entries: ExportEntry[] = [];
  for (const declaration of statement.declarationList.declarations) {
    const kind = variableKind(declaration, isConst);
    for (const name of bindingNames(declaration.name)) {
      entries.push({ kind, name });
    }
  }
  return entries;
};

/** Summarizes `export ... from` / `export { ... }` statements as one entry. */
const exportDeclarationEntries = (
  statement: ts.ExportDeclaration
): ExportEntry[] => {
  const specifier = statement.moduleSpecifier;
  const moduleText =
    specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
  const fromSuffix = moduleText === undefined ? "" : ` from ${moduleText}`;
  const clause = statement.exportClause;
  if (!clause) {
    return [{ kind: "reexport", name: `*${fromSuffix}` }];
  }
  if (ts.isNamespaceExport(clause)) {
    return [
      { kind: "reexport", name: `* as ${clause.name.text}${fromSuffix}` },
    ];
  }
  const names = clause.elements.map((element) => element.name.text);
  return [{ kind: "reexport", name: `{ ${names.join(", ")} }${fromSuffix}` }];
};

const exportAssignmentEntries = (
  statement: ts.ExportAssignment
): ExportEntry[] => {
  if (statement.isExportEquals) {
    return [{ kind: "default", name: "(export =)" }];
  }
  const expression = statement.expression;
  const name = ts.isIdentifier(expression) ? expression.text : "(expression)";
  return [{ kind: "default", name }];
};

const statementEntries = (statement: ts.Statement): ExportEntry[] => {
  if (ts.isFunctionDeclaration(statement)) {
    return declarationEntries(statement, "fn", statement.name?.text);
  }
  if (ts.isClassDeclaration(statement)) {
    return declarationEntries(statement, "class", statement.name?.text);
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return declarationEntries(statement, "interface", statement.name.text);
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return declarationEntries(statement, "type", statement.name.text);
  }
  if (ts.isEnumDeclaration(statement)) {
    return declarationEntries(statement, "enum", statement.name.text);
  }
  if (ts.isVariableStatement(statement)) {
    return variableStatementEntries(statement);
  }
  if (ts.isExportDeclaration(statement)) {
    return exportDeclarationEntries(statement);
  }
  if (ts.isExportAssignment(statement)) {
    return exportAssignmentEntries(statement);
  }
  return [];
};

/** Parses one file and returns its exports plus a file-level description. */
export const extractFileSummary = (absolutePath: string): FileSummary => {
  const sourceText = readFileSync(absolutePath, "utf8");
  const scriptKind = absolutePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const entries: ExportEntry[] = [];
  let description: string | undefined;
  for (const statement of sourceFile.statements) {
    const found = statementEntries(statement);
    if (found.length === 0) {
      continue;
    }
    entries.push(...found);
    // The first documented export supplies the file's one-line summary.
    description ??= firstJsDocLine(statement);
  }
  return { entries, description };
};
