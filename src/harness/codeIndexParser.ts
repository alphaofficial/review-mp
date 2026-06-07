import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Parser from 'tree-sitter';
import { extractCodeStructure } from './codeStructure';

const requireFromHere = createRequire(__filename);

export interface IndexedCodeBlock {
  filePath: string;
  identifier: string | null;
  type: string;
  startLine: number;
  endLine: number;
  content: string;
  fileHash: string;
  segmentHash: string;
}

export const MAX_BLOCK_CHARS = 1_000;
export const MIN_BLOCK_CHARS = 50;
export const MIN_CHUNK_REMAINDER_CHARS = 200;
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15;

type TreeSitterLanguage = Parameters<Parser['setLanguage']>[0] | TreeSitterModule;

interface TreeSitterModule {
  language?: TreeSitterLanguage;
  typescript?: TreeSitterLanguage;
  tsx?: TreeSitterLanguage;
  php?: TreeSitterLanguage;
  php_only?: TreeSitterLanguage;
}

interface ParserBundle {
  parser: Parser;
  query: Parser.Query;
}

interface BlockCandidate {
  identifier: string | null;
  type: string;
  node: Parser.SyntaxNode;
}

const parserBundles = new Map<string, ParserBundle | null>();

export function parseCodeIndexBlocks(languageId: string, code: string, filePath: string): IndexedCodeBlock[] {
  const fileHash = sha256(code);
  const bundle = getParserBundle(languageId);
  if (!bundle) {
    return fallbackBlocks(languageId, code, filePath, fileHash);
  }

  try {
    const tree = bundle.parser.parse(code);
    const candidates = dedupeCandidates(
      bundle.query.matches(tree.rootNode)
        .map(toCandidate)
        .filter((candidate): candidate is BlockCandidate => candidate !== undefined)
    );

    if (candidates.length === 0) {
      return fallbackBlocks(languageId, code, filePath, fileHash);
    }

    const blocks = candidates.flatMap((candidate) => segmentCandidate(candidate, filePath, fileHash));
    if (blocks.length === 0) {
      return fallbackBlocks(languageId, code, filePath, fileHash);
    }

    return dedupeIndexedBlocks(blocks);
  } catch {
    return fallbackBlocks(languageId, code, filePath, fileHash);
  }
}

function fallbackBlocks(languageId: string, code: string, filePath: string, fileHash: string): IndexedCodeBlock[] {
  const structure = extractCodeStructure(languageId, code, filePath);
  if (structure.blocks.length > 0) {
    return dedupeIndexedBlocks(structure.blocks.flatMap((block) => splitTextIntoBlocks({
      filePath,
      fileHash,
      identifier: block.name,
      type: block.kind,
      startLine: block.startLine,
      endLine: block.endLine,
      content: block.content,
    })));
  }

  return buildFallbackWindowBlocks(filePath, code, fileHash);
}

function getParserBundle(languageId: string): ParserBundle | null {
  if (parserBundles.has(languageId)) {
    return parserBundles.get(languageId) ?? null;
  }

  const config = getParserConfig(languageId);
  if (!config) {
    parserBundles.set(languageId, null);
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(config.language);
    const query = new Parser.Query(config.language, config.query);
    const bundle = { parser, query };
    parserBundles.set(languageId, bundle);
    return bundle;
  } catch {
    parserBundles.set(languageId, null);
    return null;
  }
}

function getParserConfig(languageId: string): { language: TreeSitterLanguage; query: string } | undefined {
  switch (languageId) {
    case 'typescript':
      return {
        language: requireTreeSitterModule('tree-sitter-typescript').typescript!,
        query: TYPESCRIPT_QUERY,
      };
    case 'typescriptreact':
      return {
        language: requireTreeSitterModule('tree-sitter-typescript').tsx!,
        query: TSX_QUERY,
      };
    case 'javascript':
    case 'javascriptreact':
    case 'json':
      return {
        language: requireTreeSitterModule('tree-sitter-javascript'),
        query: JAVASCRIPT_QUERY,
      };
    case 'python':
      return {
        language: requireTreeSitterModule('tree-sitter-python'),
        query: PYTHON_QUERY,
      };
    default:
      return undefined;
  }
}

function toCandidate(match: Parser.QueryMatch): BlockCandidate | undefined {
  const definitionCapture = match.captures.find((capture) => (
    capture.name.startsWith('definition.') || capture.name.endsWith('.definition')
  ));
  if (!definitionCapture) {
    return undefined;
  }

  const nameCapture = match.captures.find((capture) => capture.name.includes('name.definition'));
  const node = definitionCapture.node;
  const type = normalizeCaptureType(definitionCapture.name);
  const identifier = nameCapture?.node.text ?? inferIdentifier(node);

  return {
    identifier,
    type,
    node,
  };
}

function normalizeCaptureType(captureName: string): string {
  if (captureName.startsWith('definition.')) {
    return captureName.slice('definition.'.length);
  }

  if (captureName.endsWith('.definition')) {
    return captureName.slice(0, -'.definition'.length);
  }

  return captureName.replace(/^name\.definition\./, '');
}

function inferIdentifier(node: Parser.SyntaxNode): string | null {
  const directName = node.childForFieldName('name')?.text?.trim();
  if (directName) {
    return directName;
  }

  const identifierNode = node.namedChildren.find((child) => (
    child.type.includes('identifier') || child.type === 'name'
  ));
  return identifierNode?.text?.trim() || null;
}

function dedupeCandidates(candidates: BlockCandidate[]): BlockCandidate[] {
  const seen = new Set<string>();
  const deduped: BlockCandidate[] = [];

  for (const candidate of candidates) {
    const key = [
      candidate.type,
      candidate.identifier ?? '',
      candidate.node.startPosition.row,
      candidate.node.endPosition.row,
      candidate.node.startIndex,
      candidate.node.endIndex,
    ].join(':');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function segmentCandidate(candidate: BlockCandidate, filePath: string, fileHash: string): IndexedCodeBlock[] {
  const content = candidate.node.text.trim();
  if (content.length < MIN_BLOCK_CHARS) {
    return [];
  }

  if (content.length <= MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
    return [buildIndexedBlock({
      filePath,
      fileHash,
      identifier: candidate.identifier,
      type: candidate.type,
      startLine: candidate.node.startPosition.row,
      endLine: candidate.node.endPosition.row,
      content,
    })];
  }

  const childBlocks = candidate.node.namedChildren
    .filter((child) => child.text.trim().length >= MIN_BLOCK_CHARS)
    .flatMap((child) => segmentCandidate({
      identifier: inferIdentifier(child) ?? candidate.identifier,
      type: child.type,
      node: child,
    }, filePath, fileHash));

  if (childBlocks.length > 0) {
    return childBlocks;
  }

  return splitTextIntoBlocks({
    filePath,
    fileHash,
    identifier: candidate.identifier,
    type: candidate.type,
    startLine: candidate.node.startPosition.row,
    endLine: candidate.node.endPosition.row,
    content,
  });
}

function splitTextIntoBlocks(input: {
  filePath: string;
  fileHash: string;
  identifier: string | null;
  type: string;
  startLine: number;
  endLine: number;
  content: string;
}): IndexedCodeBlock[] {
  const lines = input.content.split('\n');
  const blocks: IndexedCodeBlock[] = [];
  let currentLines: string[] = [];
  let currentStartLine = input.startLine;
  let currentLength = 0;

  const flush = (endLine: number): void => {
    const content = currentLines.join('\n').trim();
    if (content.length >= MIN_BLOCK_CHARS) {
      blocks.push(buildIndexedBlock({
        ...input,
        startLine: currentStartLine,
        endLine,
        content,
      }));
    }
    currentLines = [];
    currentLength = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const absoluteLine = input.startLine + index;
    const additionLength = currentLines.length === 0 ? line.length : line.length + 1;
    const remainingContentLength = lines.slice(index).join('\n').trim().length;

    if (
      currentLines.length > 0
      && currentLength + additionLength > MAX_BLOCK_CHARS
      && remainingContentLength >= MIN_CHUNK_REMAINDER_CHARS
    ) {
      flush(absoluteLine - 1);
      currentStartLine = absoluteLine;
    }

    if (currentLines.length === 0) {
      currentStartLine = absoluteLine;
    }

    currentLines.push(line);
    currentLength += currentLines.length === 1 ? line.length : line.length + 1;
  }

  if (currentLines.length > 0) {
    flush(input.endLine);
  }

  if (blocks.length === 0 && input.content.trim().length >= MIN_BLOCK_CHARS) {
    return [buildIndexedBlock({
      ...input,
      content: input.content.trim().slice(0, MAX_BLOCK_CHARS),
    })];
  }

  return blocks;
}

function buildFallbackWindowBlocks(filePath: string, code: string, fileHash: string): IndexedCodeBlock[] {
  const lines = code.split('\n');
  const blocks: IndexedCodeBlock[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length) {
      const lineLength = lines[end].length + (end === start ? 0 : 1);
      if (length + lineLength > MAX_BLOCK_CHARS && length >= MIN_BLOCK_CHARS) {
        break;
      }
      length += lineLength;
      end += 1;
    }

    const content = lines.slice(start, end).join('\n').trim();
    if (content.length >= MIN_BLOCK_CHARS) {
      blocks.push(buildIndexedBlock({
        filePath,
        fileHash,
        identifier: null,
        type: 'file',
        startLine: start,
        endLine: end - 1,
        content,
      }));
    }
    start = Math.max(end, start + 1);
  }

  return blocks;
}

function buildIndexedBlock(input: {
  filePath: string;
  fileHash: string;
  identifier: string | null;
  type: string;
  startLine: number;
  endLine: number;
  content: string;
}): IndexedCodeBlock {
  const normalizedContent = input.content.trim();
  return {
    filePath: input.filePath,
    identifier: input.identifier,
    type: input.type,
    startLine: input.startLine,
    endLine: input.endLine,
    content: normalizedContent,
    fileHash: input.fileHash,
    segmentHash: sha256([
      input.filePath,
      input.identifier ?? '',
      input.type,
      input.startLine,
      input.endLine,
      normalizedContent,
    ].join('\n')),
  };
}

function dedupeIndexedBlocks(blocks: IndexedCodeBlock[]): IndexedCodeBlock[] {
  const seen = new Set<string>();
  const deduped: IndexedCodeBlock[] = [];

  for (const block of blocks) {
    if (seen.has(block.segmentHash)) {
      continue;
    }
    seen.add(block.segmentHash);
    deduped.push(block);
  }

  return deduped;
}

function requireTreeSitterModule(moduleName: string): TreeSitterModule {
  return requireFromHere(moduleName) as TreeSitterModule;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TYPESCRIPT_QUERY = `
(function_signature
  name: (identifier) @name.definition.function) @definition.function
(method_signature
  name: (property_identifier) @name.definition.method) @definition.method
(function_declaration
  name: (identifier) @name.definition.function) @definition.function
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type
(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function
`;

const TSX_QUERY = `
(function_declaration
  name: (identifier) @name.definition.function) @definition.function
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function
`;

const JAVASCRIPT_QUERY = `
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method
[(class) (class_declaration)]
  name: (_) @name.definition.class @definition.class
(function_declaration
  name: (identifier) @name.definition.function) @definition.function
(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function
(object) @object.definition
(array) @array.definition
(pair
  key: (_) @name.definition.property) @property.definition
`;

const PYTHON_QUERY = `
(class_definition
  name: (identifier) @name.definition.class) @definition.class
(decorated_definition
  definition: (class_definition
    name: (identifier) @name.definition.class)) @definition.class
(function_definition
  name: (identifier) @name.definition.function) @definition.function
(decorated_definition
  definition: (function_definition
    name: (identifier) @name.definition.function)) @definition.function
(with_statement) @definition.with_statement
(try_statement) @definition.try_statement
`;
