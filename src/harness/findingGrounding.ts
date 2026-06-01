import fs from 'node:fs';
import path from 'node:path';
import { CodeBlock, extractCodeStructure, getLanguageIdFromFilePath } from './codeStructure';
import { ReviewComment, ReviewRequest } from '../types/review';

interface SourceForReview {
  filePath: string;
  content: string;
  languageId: string;
}

interface GroundingEvidence {
  blocks: CodeBlock[];
  identifiers: Set<string>;
  declarationsByName: Map<string, CodeBlock[]>;
  lineTextByNumber: Map<number, string>;
}

export async function filterUnsupportedFindings(
  request: ReviewRequest,
  comments: ReviewComment[],
  workspaceRoot?: string
): Promise<ReviewComment[]> {
  if (comments.length === 0) {
    return comments;
  }

  const source = loadSourceForRequest(request, workspaceRoot);
  if (!source) {
    return comments;
  }

  const reviewMaterial = buildReviewMaterial(request, source);
  const structure = extractCodeStructure(source.languageId, source.content, source.filePath);
  const sourceEvidence = structure.parser === 'none'
    ? undefined
    : buildGroundingEvidence(source.content, structure.blocks);

  return comments.filter((comment) => {
    if (comment.evidence && comment.evidence.length > 0) {
      return hasGroundedEvidence(comment, reviewMaterial);
    }

    return sourceEvidence ? !isDirectlyContradictedBySource(comment, sourceEvidence) : true;
  });
}

function hasGroundedEvidence(comment: ReviewComment, reviewMaterial: string): boolean {
  return comment.evidence?.some((item) => {
    const quote = normalizeEvidenceQuote(item.quote);
    return quote.length > 0 && reviewMaterial.includes(quote);
  }) ?? false;
}

function buildReviewMaterial(request: ReviewRequest, source: SourceForReview): string {
  const packageMaterial = request.reviewPackage
    ? [
        request.reviewPackage.target.content,
        ...request.reviewPackage.supportingContext.map((item) => item.content),
      ].join('\n\n')
    : '';

  return [
    source.content,
    request.code,
    request.diff,
    request.crossFileContext,
    packageMaterial,
  ].filter((value): value is string => Boolean(value)).join('\n\n');
}

function isDirectlyContradictedBySource(comment: ReviewComment, evidence: GroundingEvidence): boolean {
  const citedIdentifiers = extractCitedIdentifiers(comment);
  if (citedIdentifiers.length === 0 || !statesAbsenceClaim(comment)) {
    return false;
  }

  const line = Math.max(0, comment.line);
  for (const identifier of citedIdentifiers) {
    if (!evidence.identifiers.has(identifier)) {
      continue;
    }

    if (isDeclaredNearLine(identifier, line, evidence) || isPresentOnCitedLine(identifier, line, evidence)) {
      return true;
    }
  }

  return false;
}

function buildGroundingEvidence(content: string, blocks: CodeBlock[]): GroundingEvidence {
  const declarationsByName = new Map<string, CodeBlock[]>();
  const identifiers = new Set<string>();

  for (const block of blocks) {
    identifiers.add(block.name);
    const declarations = declarationsByName.get(block.name) ?? [];
    declarations.push(block);
    declarationsByName.set(block.name, declarations);

    for (const identifier of extractIdentifiersFromText(block.content)) {
      identifiers.add(identifier);
    }
  }

  const lineTextByNumber = new Map<number, string>();
  content.split('\n').forEach((line, index) => {
    lineTextByNumber.set(index, line);
    for (const identifier of extractIdentifiersFromText(line)) {
      identifiers.add(identifier);
    }
  });

  return {
    blocks,
    identifiers,
    declarationsByName,
    lineTextByNumber,
  };
}

function isDeclaredNearLine(identifier: string, line: number, evidence: GroundingEvidence): boolean {
  const directDeclarations = evidence.declarationsByName.get(identifier) ?? [];
  if (directDeclarations.some((block) => isNearLine(block, line))) {
    return true;
  }

  return evidence.blocks.some((block) => (
    isTypeLikeBlock(block)
    && isNearLine(block, line)
    && blockContainsIdentifier(block, identifier)
  ));
}

function isPresentOnCitedLine(identifier: string, line: number, evidence: GroundingEvidence): boolean {
  const nearbyLines = [
    evidence.lineTextByNumber.get(line),
    evidence.lineTextByNumber.get(line - 1),
    evidence.lineTextByNumber.get(line + 1),
  ].filter((text): text is string => text !== undefined);

  return nearbyLines.some((text) => hasIdentifier(text, identifier));
}

function extractCitedIdentifiers(comment: ReviewComment): string[] {
  const text = `${comment.title ?? ''}\n${comment.message}`;
  const candidates = extractIdentifiersFromText(text)
    .filter((identifier) => !COMMON_WORDS.has(identifier))
    .filter((identifier) => identifier.length > 2 || /^[A-Z]/.test(identifier));

  return [...new Set(candidates)];
}

function statesAbsenceClaim(comment: ReviewComment): boolean {
  const text = `${comment.title ?? ''} ${comment.message}`.toLowerCase();
  return (
    text.includes('does not exist')
    || text.includes('do not exist')
    || text.includes('doesn\'t exist')
    || text.includes('not defined')
    || text.includes('undefined')
    || text.includes('unresolved')
    || text.includes('missing')
    || text.includes('not in type')
    || text.includes('not on type')
  );
}

function isNearLine(block: CodeBlock, line: number): boolean {
  return block.startLine <= line + 20 && block.endLine >= Math.max(0, line - 40);
}

function isTypeLikeBlock(block: CodeBlock): boolean {
  return block.kind === 'interface' || block.kind === 'type' || block.kind === 'class' || block.kind === 'struct';
}

function blockContainsIdentifier(block: CodeBlock, identifier: string): boolean {
  return hasIdentifier(block.content, identifier);
}

function hasIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(identifier)}([^A-Za-z0-9_$]|$)`).test(text);
}

function extractIdentifiersFromText(text: string): string[] {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

function normalizeEvidenceQuote(quote: string): string {
  return quote
    .replace(/^L\d+\s*\|\s*/gm, '')
    .replace(/^\d+:\s*/gm, '')
    .trim();
}

function loadSourceForRequest(
  request: ReviewRequest,
  workspaceRoot?: string
): SourceForReview | null {
  if (request.reviewType === 'file') {
    return {
      filePath: request.filePath,
      content: request.code,
      languageId: request.languageId || getLanguageIdFromFilePath(request.filePath),
    };
  }

  if (request.reviewType === 'selection') {
    return {
      filePath: request.filePath,
      content: request.fullDocumentCode ?? request.code,
      languageId: request.languageId || getLanguageIdFromFilePath(request.filePath),
    };
  }

  if (!request.filePath || request.filePath.includes(', ')) {
    return null;
  }

  const absolutePath = workspaceRoot && !path.isAbsolute(request.filePath)
    ? path.join(workspaceRoot, request.filePath)
    : request.filePath;

  try {
    return {
      filePath: absolutePath,
      content: fs.readFileSync(absolutePath, 'utf8'),
      languageId: request.languageId || getLanguageIdFromFilePath(absolutePath),
    };
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMMON_WORDS = new Set([
  'The',
  'This',
  'That',
  'There',
  'These',
  'Those',
  'Function',
  'function',
  'Property',
  'property',
  'Type',
  'type',
  'From',
  'from',
  'Does',
  'does',
  'Not',
  'not',
  'Exist',
  'exist',
  'Missing',
  'missing',
  'Undefined',
  'undefined',
  'Unresolved',
  'unresolved',
  'Destructured',
  'destructured',
  'Destructures',
  'destructures',
]);
