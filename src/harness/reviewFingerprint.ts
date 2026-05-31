import { createHash } from 'node:crypto';

const REVIEW_TARGET_FINGERPRINT_SALT = 'review-target-fingerprint-2026-05-30';
const REVIEW_UNIT_FINGERPRINT_SALT = 'review-unit-fingerprint-2026-05-30';
const REVIEW_FINDING_KEY_SALT = 'review-finding-key-2026-05-30';
const SELECTION_CONTEXT_RADIUS = 4;

interface FindingIdentity {
  file: string;
  line: number;
  title?: string;
  message: string;
  fix?: string;
  severity?: string;
}

export function computeDiffReviewFingerprint(diff: string): string {
  return hashParts(REVIEW_TARGET_FINGERPRINT_SALT, ['diff', normalizeLineEndings(diff).trim()]);
}

export function computeFileReviewFingerprint(filePath: string, code: string): string {
  return hashParts(REVIEW_TARGET_FINGERPRINT_SALT, [
    'file',
    normalizePath(filePath),
    sha256(normalizeLineEndings(code)),
  ]);
}

export function computeSelectionReviewFingerprint(
  filePath: string,
  selectedCode: string,
  startLine?: number,
  fullDocumentCode?: string
): string {
  return hashParts(REVIEW_TARGET_FINGERPRINT_SALT, [
    'selection',
    normalizePath(filePath),
    String(startLine ?? -1),
    sha256(normalizeLineEndings(selectedCode)),
    hashSelectionContext(fullDocumentCode, startLine, selectedCode),
  ]);
}

export function computeDiffUnitFingerprint(filePaths: string[], diff: string): string {
  return hashParts(REVIEW_UNIT_FINGERPRINT_SALT, [
    'diff-unit',
    filePaths.map(normalizePath).sort().join('\n'),
    normalizeLineEndings(diff).trim(),
  ]);
}

export function computeFileUnitFingerprint(
  filePath: string,
  startLine: number,
  endLine: number,
  code: string,
  pathHint?: string
): string {
  return hashParts(REVIEW_UNIT_FINGERPRINT_SALT, [
    'file-unit',
    normalizePath(filePath),
    `${startLine}-${endLine}`,
    pathHint?.trim() ?? '',
    sha256(normalizeLineEndings(code)),
  ]);
}

export function computeFindingKey(finding: FindingIdentity): string {
  return hashParts(REVIEW_FINDING_KEY_SALT, [
    normalizePath(finding.file),
    String(finding.line),
    finding.title?.trim() ?? '',
    finding.message.trim(),
    finding.fix?.trim() ?? '',
    finding.severity?.trim() ?? '',
  ]);
}

function hashSelectionContext(fullDocumentCode: string | undefined, startLine: number | undefined, selectedCode: string): string {
  if (!fullDocumentCode || startLine === undefined) {
    return sha256(normalizeLineEndings(selectedCode));
  }

  const selectedLineCount = selectedCode.split('\n').length;
  const lines = normalizeLineEndings(fullDocumentCode).split('\n');
  const contextStart = Math.max(0, startLine - SELECTION_CONTEXT_RADIUS);
  const contextEnd = Math.min(lines.length, startLine + selectedLineCount + SELECTION_CONTEXT_RADIUS);
  return sha256(lines.slice(contextStart, contextEnd).join('\n'));
}

function hashParts(salt: string, parts: string[]): string {
  return sha256([salt, ...parts].join('\n'));
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
