import path from 'node:path';
import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import type { Node as TsMorphNode, SourceFile as TsMorphSourceFile } from 'ts-morph';

const requireFromHere = createRequire(__filename);

export interface CodeBlock {
  name: string;
  kind: 'function' | 'class' | 'const' | 'interface' | 'type' | 'enum' | 'struct' | 'module';
  startLine: number;
  endLine: number;
  content: string;
}

export interface ImportInfo {
  path: string;
  symbols: string[];
}

export interface CodeReference {
  symbol: string;
  line: number;
}

export interface CodeRelationship {
  kind: 'imports' | 'references';
  sourceSymbol?: string;
  targetSymbol?: string;
  targetPath?: string;
  line: number;
}

export interface CodeStructure {
  blocks: CodeBlock[];
  imports: ImportInfo[];
  references: CodeReference[];
  relationships: CodeRelationship[];
  parser: 'ts-morph' | 'tree-sitter' | 'none';
}

type TreeSitterLanguage = Parser.Language | TreeSitterModule;

interface TreeSitterModule {
  language?: TreeSitterLanguage;
  typescript?: TreeSitterLanguage;
  tsx?: TreeSitterLanguage;
  php?: TreeSitterLanguage;
  php_only?: TreeSitterLanguage;
}

interface ParserConfig {
  language: TreeSitterLanguage;
  parserName: 'tree-sitter';
}

const parserCache = new Map<string, ParserConfig | undefined>();
let parserConstructor: typeof Parser | undefined;
let tsMorphApi: typeof import('ts-morph') | undefined;

export function extractCodeStructure(languageId: string, code: string, filePath?: string): CodeStructure {
  if (isTypeScriptFamily(languageId)) {
    const tsStructure = extractTsMorphStructure(languageId, code, filePath);
    if (tsStructure.blocks.length > 0 || tsStructure.imports.length > 0) {
      return tsStructure;
    }
  }

  const treeSitterStructure = extractTreeSitterStructure(languageId, code, filePath);
  if (treeSitterStructure) {
    return treeSitterStructure;
  }

  return {
    blocks: [],
    imports: [],
    references: [],
    relationships: [],
    parser: 'none',
  };
}

export function extractCodeBlocks(languageId: string, code: string, filePath?: string): CodeBlock[] {
  return extractCodeStructure(languageId, code, filePath).blocks;
}

export function selectBlocksBySymbols(blocks: CodeBlock[], symbols: string[]): CodeBlock[] {
  const symbolSet = new Set(symbols);
  return blocks.filter((block) => symbolSet.has(block.name));
}

export function extractImportsFromSource(languageId: string, source: string, filePath?: string): ImportInfo[] {
  return extractCodeStructure(languageId, source, filePath).imports;
}

export function getSupportedCodeExtensions(): Set<string> {
  return new Set([
    '.c',
    '.cc',
    '.cpp',
    '.cs',
    '.go',
    '.h',
    '.hpp',
    '.java',
    '.js',
    '.jsx',
    '.kt',
    '.kts',
    '.php',
    '.py',
    '.rb',
    '.rs',
    '.swift',
    '.ts',
    '.tsx',
  ]);
}

export function getLanguageIdFromFilePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.c':
    case '.h':
      return 'c';
    case '.cc':
    case '.cpp':
    case '.hpp':
      return 'cpp';
    case '.cs':
      return 'csharp';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    case '.js':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.php':
      return 'php';
    case '.py':
      return 'python';
    case '.rb':
      return 'ruby';
    case '.rs':
      return 'rust';
    case '.swift':
      return 'swift';
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.json':
      return 'json';
    default:
      return ext.replace(/^\./, '') || 'plaintext';
  }
}

function extractTsMorphStructure(languageId: string, code: string, filePath?: string): CodeStructure {
  const { Project } = getTsMorphApi();
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      jsx: 4,
    },
  });
  const sourceFile = project.createSourceFile(filePath ?? getVirtualTsFileName(languageId), code, {
    scriptKind: getTsMorphScriptKind(languageId),
    overwrite: true,
  });
  const blocks: CodeBlock[] = [];
  const relationships: CodeRelationship[] = [];

  for (const statement of sourceFile.getStatements()) {
    const block = tsMorphStatementToBlock(sourceFile, statement);
    if (block) {
      blocks.push(block);
    }
  }

  const imports = sourceFile.getImportDeclarations().map((declaration) => {
    const symbols = [
      declaration.getDefaultImport()?.getText(),
      declaration.getNamespaceImport()?.getText(),
      ...declaration.getNamedImports().map((specifier) => specifier.getName()),
    ].filter((symbol): symbol is string => Boolean(symbol));
    const line = declaration.getStartLineNumber() - 1;
    relationships.push({
      kind: 'imports',
      targetPath: declaration.getModuleSpecifierValue(),
      targetSymbol: symbols[0],
      line,
    });
    return {
      path: declaration.getModuleSpecifierValue(),
      symbols,
    };
  });

  const references = collectTsMorphReferences(sourceFile, new Set(blocks.map((block) => block.name)));
  relationships.push(...references.map((reference) => ({
    kind: 'references' as const,
    targetSymbol: reference.symbol,
    line: reference.line,
  })));

  return {
    blocks: dedupeBlocks(blocks),
    imports,
    references,
    relationships,
    parser: 'ts-morph',
  };
}

function tsMorphStatementToBlock(sourceFile: TsMorphSourceFile, statement: TsMorphNode): CodeBlock | undefined {
  const { Node } = getTsMorphApi();
  if (Node.isFunctionDeclaration(statement) && statement.getName()) {
    return toTsMorphBlock(statement, statement.getName()!, 'function');
  }

  if (Node.isClassDeclaration(statement) && statement.getName()) {
    return toTsMorphBlock(statement, statement.getName()!, 'class');
  }

  if (Node.isInterfaceDeclaration(statement)) {
    return toTsMorphBlock(statement, statement.getName(), 'interface');
  }

  if (Node.isTypeAliasDeclaration(statement)) {
    return toTsMorphBlock(statement, statement.getName(), 'type');
  }

  if (Node.isEnumDeclaration(statement)) {
    return toTsMorphBlock(statement, statement.getName(), 'enum');
  }

  if (Node.isVariableStatement(statement)) {
    const declaration = statement.getDeclarationList().getDeclarations()
      .find((item) => Node.isIdentifier(item.getNameNode()));
    if (declaration) {
      return toTsMorphBlock(statement, declaration.getName(), 'const');
    }
  }

  return undefined;
}

function toTsMorphBlock(node: TsMorphNode, name: string, kind: CodeBlock['kind']): CodeBlock {
  return {
    name,
    kind,
    startLine: node.getStartLineNumber() - 1,
    endLine: node.getEndLineNumber() - 1,
    content: node.getText(),
  };
}

function collectTsMorphReferences(sourceFile: TsMorphSourceFile, declaredSymbols: Set<string>): CodeReference[] {
  const { Node } = getTsMorphApi();
  const references: CodeReference[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) {
      return;
    }
    const symbol = node.getText();
    if (!declaredSymbols.has(symbol)) {
      return;
    }
    references.push({
      symbol,
      line: node.getStartLineNumber() - 1,
    });
  });
  return dedupeReferences(references);
}

function extractTreeSitterStructure(languageId: string, code: string, filePath?: string): CodeStructure | undefined {
  const config = getTreeSitterParserConfig(languageId);
  if (!config) {
    return undefined;
  }

  const ParserConstructor = getTreeSitterParserConstructor();
  const parser = new ParserConstructor();
  parser.setLanguage(config.language as Parser.Language);
  const tree = parser.parse(code);
  const blocks: CodeBlock[] = [];
  const imports: ImportInfo[] = [];
  const references: CodeReference[] = [];
  const relationships: CodeRelationship[] = [];
  const declaredSymbols = new Set<string>();

  traverseTree(tree.rootNode, (node) => {
    if (isDeclarationNode(node)) {
      const name = findNodeName(node);
      if (name) {
        declaredSymbols.add(name);
        blocks.push({
          name,
          kind: classifyDeclarationKind(node.type),
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          content: node.text.trim(),
        });
      }
    }

    if (isImportNode(node)) {
      const importInfo = extractTreeSitterImport(node, languageId);
      if (importInfo) {
        imports.push(importInfo);
        relationships.push({
          kind: 'imports',
          targetPath: importInfo.path,
          targetSymbol: importInfo.symbols[0],
          line: node.startPosition.row,
        });
      }
    }
  });

  traverseTree(tree.rootNode, (node) => {
    if (!isIdentifierLike(node)) {
      return;
    }
    const symbol = node.text;
    if (!declaredSymbols.has(symbol)) {
      return;
    }
    references.push({
      symbol,
      line: node.startPosition.row,
    });
    relationships.push({
      kind: 'references',
      targetSymbol: symbol,
      line: node.startPosition.row,
    });
  });

  return {
    blocks: dedupeBlocks(blocks),
    imports: dedupeImports(imports),
    references: dedupeReferences(references),
    relationships: dedupeRelationships(relationships),
    parser: config.parserName,
  };
}

function getTreeSitterParserConfig(languageId: string): ParserConfig | undefined {
  const normalized = languageId.toLowerCase();
  const cached = parserCache.get(normalized);
  if (parserCache.has(normalized)) {
    return cached;
  }

  const loaded = loadTreeSitterLanguage(normalized);
  parserCache.set(normalized, loaded);
  return loaded;
}

function loadTreeSitterLanguage(languageId: string): ParserConfig | undefined {
  try {
    switch (languageId) {
      case 'typescript':
      case 'ts':
        return { language: requireTreeSitterModule('tree-sitter-typescript').typescript!, parserName: 'tree-sitter' };
      case 'typescriptreact':
      case 'tsx':
        return { language: requireTreeSitterModule('tree-sitter-typescript').tsx!, parserName: 'tree-sitter' };
      case 'javascript':
      case 'javascriptreact':
      case 'js':
      case 'jsx':
        return { language: requireTreeSitterModule('tree-sitter-javascript'), parserName: 'tree-sitter' };
      case 'python':
      case 'py':
        return { language: requireTreeSitterModule('tree-sitter-python'), parserName: 'tree-sitter' };
      case 'go':
        return { language: requireTreeSitterModule('tree-sitter-go'), parserName: 'tree-sitter' };
      case 'rust':
      case 'rs':
        return { language: requireTreeSitterModule('tree-sitter-rust'), parserName: 'tree-sitter' };
      case 'java':
        return { language: requireTreeSitterModule('tree-sitter-java'), parserName: 'tree-sitter' };
      case 'csharp':
      case 'cs':
        return { language: loadNativeTreeSitterLanguage('tree-sitter-c-sharp'), parserName: 'tree-sitter' };
      case 'php':
        return { language: requireTreeSitterModule('tree-sitter-php').php!, parserName: 'tree-sitter' };
      case 'ruby':
      case 'rb':
        return { language: requireTreeSitterModule('tree-sitter-ruby'), parserName: 'tree-sitter' };
      case 'c':
        return { language: requireTreeSitterModule('tree-sitter-c'), parserName: 'tree-sitter' };
      case 'cpp':
      case 'cc':
      case 'cxx':
        return { language: requireTreeSitterModule('tree-sitter-cpp'), parserName: 'tree-sitter' };
      case 'swift':
        return { language: requireTreeSitterModule('tree-sitter-swift'), parserName: 'tree-sitter' };
      case 'kotlin':
      case 'kt':
      case 'kts':
        return { language: requireTreeSitterModule('tree-sitter-kotlin'), parserName: 'tree-sitter' };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function requireTreeSitterModule(packageName: string): TreeSitterModule {
  return requireFromHere(packageName) as TreeSitterModule;
}

function getTreeSitterParserConstructor(): typeof Parser {
  parserConstructor ??= requireFromHere('tree-sitter') as typeof Parser;
  return parserConstructor;
}

function getTsMorphApi(): typeof import('ts-morph') {
  tsMorphApi ??= requireFromHere('ts-morph') as typeof import('ts-morph');
  return tsMorphApi;
}

function loadNativeTreeSitterLanguage(packageName: string): TreeSitterLanguage {
  const packageRoot = path.dirname(requireFromHere.resolve(`${packageName}/package.json`));
  const loadNative = requireFromHere('node-gyp-build') as (root: string) => TreeSitterModule;
  return loadNative(packageRoot);
}

function traverseTree(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child) {
      traverseTree(child, visit);
    }
  }
}

function isDeclarationNode(node: Parser.SyntaxNode): boolean {
  const type = node.type;
  if (type.includes('import') || type.includes('package') || type.includes('namespace')) {
    return false;
  }

  return [
    'function',
    'method',
    'class',
    'interface',
    'enum',
    'struct',
    'trait',
    'impl',
    'type',
    'module',
    'const',
    'variable',
  ].some((marker) => type.includes(marker) && (type.includes('declaration') || type.includes('definition') || type.includes('item')));
}

function classifyDeclarationKind(nodeType: string): CodeBlock['kind'] {
  if (nodeType.includes('class')) {
    return 'class';
  }
  if (nodeType.includes('interface')) {
    return 'interface';
  }
  if (nodeType.includes('enum')) {
    return 'enum';
  }
  if (nodeType.includes('struct') || nodeType.includes('trait')) {
    return 'struct';
  }
  if (nodeType.includes('type')) {
    return 'type';
  }
  if (nodeType.includes('module') || nodeType.includes('namespace')) {
    return 'module';
  }
  if (nodeType.includes('const') || nodeType.includes('variable')) {
    return 'const';
  }
  return 'function';
}

function findNodeName(node: Parser.SyntaxNode): string | undefined {
  const namedField = node.childForFieldName('name');
  if (namedField && isIdentifierLike(namedField)) {
    return namedField.text;
  }

  const candidates: string[] = [];
  traverseTree(node, (child) => {
    if (child === node || !isIdentifierLike(child)) {
      return;
    }
    candidates.push(child.text);
  });
  return candidates[0];
}

function isImportNode(node: Parser.SyntaxNode): boolean {
  return [
    'import_statement',
    'import_declaration',
    'import_from_statement',
    'use_declaration',
    'use_item',
    'include',
    'include_expression',
    'require',
    'require_call',
    'preproc_include',
  ].includes(node.type) || node.type.includes('import');
}

function extractTreeSitterImport(node: Parser.SyntaxNode, languageId: string): ImportInfo | undefined {
  const text = node.text;
  const quotedPath = text.match(/["']([^"']+)["']/)?.[1];
  const pythonFrom = text.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
  const rustUse = text.match(/^use\s+(.+?);?$/);
  const pathValue = quotedPath
    ?? (pythonFrom ? pythonModuleToPath(pythonFrom[1]) : undefined)
    ?? (rustUse ? rustUse[1].replace(/::/g, '/') : undefined);

  if (!pathValue) {
    return undefined;
  }

  const symbols = collectIdentifierTexts(node)
    .filter((symbol) => !['from', 'import', 'use', 'require', 'include'].includes(symbol))
    .slice(0, 12);

  return {
    path: pathValue,
    symbols,
  };
}

function pythonModuleToPath(moduleName: string): string {
  const leadingDots = moduleName.match(/^\.+/)?.[0] ?? '';
  const rest = moduleName.slice(leadingDots.length).replace(/\./g, '/');
  return `${leadingDots.length > 0 ? './'.repeat(leadingDots.length) : ''}${rest}` || '.';
}

function collectIdentifierTexts(node: Parser.SyntaxNode): string[] {
  const symbols: string[] = [];
  traverseTree(node, (child) => {
    if (isIdentifierLike(child)) {
      symbols.push(child.text);
    }
  });
  return [...new Set(symbols)];
}

function isIdentifierLike(node: Parser.SyntaxNode): boolean {
  return [
    'identifier',
    'type_identifier',
    'field_identifier',
    'property_identifier',
    'constant_identifier',
    'scoped_identifier',
    'namespace_identifier',
  ].includes(node.type);
}

function getVirtualTsFileName(languageId: string): string {
  return isTsxLike(languageId)
    ? 'file.tsx'
    : isJsxLike(languageId)
      ? 'file.jsx'
      : isJavaScriptLike(languageId)
        ? 'file.js'
        : 'file.ts';
}

function getTsMorphScriptKind(languageId: string): import('ts-morph').ScriptKind {
  const { ScriptKind } = getTsMorphApi();
  if (isTsxLike(languageId)) {
    return ScriptKind.TSX;
  }
  if (isJsxLike(languageId)) {
    return ScriptKind.JSX;
  }
  if (isJavaScriptLike(languageId)) {
    return ScriptKind.JS;
  }
  return ScriptKind.TS;
}

function isTypeScriptFamily(languageId: string): boolean {
  return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'ts', 'tsx', 'js', 'jsx'].includes(languageId.toLowerCase());
}

function isTsxLike(languageId: string): boolean {
  return ['typescriptreact', 'tsx'].includes(languageId.toLowerCase());
}

function isJsxLike(languageId: string): boolean {
  return ['javascriptreact', 'jsx'].includes(languageId.toLowerCase());
}

function isJavaScriptLike(languageId: string): boolean {
  return ['javascript', 'javascriptreact', 'js', 'jsx'].includes(languageId.toLowerCase());
}

function dedupeBlocks(blocks: CodeBlock[]): CodeBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.name}:${block.kind}:${block.startLine}:${block.endLine}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeImports(imports: ImportInfo[]): ImportInfo[] {
  const seen = new Set<string>();
  return imports.filter((importInfo) => {
    const key = `${importInfo.path}:${importInfo.symbols.join(',')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeReferences(references: CodeReference[]): CodeReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.symbol}:${reference.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeRelationships(relationships: CodeRelationship[]): CodeRelationship[] {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    const key = `${relationship.kind}:${relationship.sourceSymbol ?? ''}:${relationship.targetSymbol ?? ''}:${relationship.targetPath ?? ''}:${relationship.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
