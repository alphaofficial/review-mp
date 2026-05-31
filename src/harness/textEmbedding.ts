import { createHash } from 'node:crypto';

export const DEFAULT_EMBEDDING_DIMENSION = 128;
export const EMBEDDING_ALGORITHM_VERSION = 'deterministic-hash-v1';

export function embedText(text: string, dimension: number = DEFAULT_EMBEDDING_DIMENSION): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const normalized = text.toLowerCase();
  const tokens = tokenize(normalized);

  for (const token of tokens) {
    const weight = 1 + Math.log(1 + token.length);
    const primary = hashToIndex(token, dimension);
    const secondary = hashToIndex(`secondary:${token}`, dimension);
    vector[primary] += weight;
    vector[secondary] -= weight * 0.5;
  }

  for (const ngram of buildCharacterNgrams(normalized)) {
    const index = hashToIndex(`ngram:${ngram}`, dimension);
    vector[index] += 0.35;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function tokenize(text: string): string[] {
  return text
    .split(/[^a-z0-9_#/.-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildCharacterNgrams(text: string): string[] {
  const compact = text.replace(/\s+/g, ' ').trim();
  const ngrams: string[] = [];

  for (let index = 0; index < compact.length - 2; index += 1) {
    ngrams.push(compact.slice(index, index + 3));
  }

  return ngrams;
}

function hashToIndex(value: string, dimension: number): number {
  const hash = createHash('sha256').update(value).digest();
  return hash.readUInt32BE(0) % dimension;
}
