import { createHash } from 'node:crypto';

export interface QdrantClientOptions {
  apiKey?: string;
  baseUrl: string;
  collectionName: string;
  dimension: number;
}

export interface QdrantPoint<RecordPayload extends Record<string, unknown>> {
  id: string;
  payload: RecordPayload;
  vector: number[];
}

export interface QdrantQueryOptions {
  filter?: Record<string, unknown>;
  limit: number;
  scoreThreshold?: number;
}

export interface QdrantQueryResult<RecordPayload extends Record<string, unknown>> {
  id: string;
  payload: RecordPayload;
  score: number;
}

export class QdrantClient {
  constructor(private readonly options: QdrantClientOptions) {}

  async ensureCollection(): Promise<void> {
    const response = await this.request('GET', `/collections/${this.options.collectionName}`, undefined, true);
    if (response.status === 404) {
      await this.recreateCollection();
      return;
    }

    const info = await response.json() as {
      result?: {
        config?: {
          params?: {
            vectors?: {
              size?: number;
            };
          };
        };
      };
    };
    const actualDimension = info?.result?.config?.params?.vectors?.size;
    if (typeof actualDimension === 'number' && actualDimension !== this.options.dimension) {
      throw new Error(`Qdrant collection dimension mismatch: expected ${this.options.dimension}, got ${actualDimension}`);
    }
  }

  async recreateCollection(): Promise<void> {
    await this.request('DELETE', `/collections/${this.options.collectionName}`, undefined, true);
    await this.request('PUT', `/collections/${this.options.collectionName}`, {
      vectors: {
        size: this.options.dimension,
        distance: 'Cosine',
      },
    });
  }

  async deleteCollection(): Promise<void> {
    await this.request('DELETE', `/collections/${this.options.collectionName}`, undefined, true);
  }

  async upsertPoints<RecordPayload extends Record<string, unknown>>(points: Array<QdrantPoint<RecordPayload>>): Promise<void> {
    if (points.length === 0) {
      return;
    }

    await this.request('PUT', `/collections/${this.options.collectionName}/points`, {
      points: points.map((point) => ({
        ...point,
        id: normalizeQdrantPointId(point.id),
      })),
    });
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/collections/${this.options.collectionName}/points/delete`, {
      filter,
    });
  }

  async query<RecordPayload extends Record<string, unknown>>(
    vector: number[],
    options: QdrantQueryOptions
  ): Promise<Array<QdrantQueryResult<RecordPayload>>> {
    const response = await this.request('POST', `/collections/${this.options.collectionName}/points/query`, {
      query: vector,
      limit: options.limit,
      filter: options.filter,
      with_payload: true,
      score_threshold: options.scoreThreshold,
    });
    const body = await response.json() as QueryResponse<RecordPayload>;
    const result = body?.result;
    const rows = Array.isArray(result)
      ? result
      : Array.isArray(result?.points)
        ? result.points
        : [];

    return rows.map((row) => ({
      id: String(row.id),
      payload: row.payload,
      score: typeof row.score === 'number' ? row.score : 0,
    }));
  }

  private async request(
    method: 'DELETE' | 'GET' | 'POST' | 'PUT',
    pathname: string,
    body?: Record<string, unknown>,
    allow404 = false
  ): Promise<Response> {
    const response = await fetch(`${this.options.baseUrl}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { 'api-key': this.options.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (allow404 && response.status === 404) {
      return response;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Qdrant request failed (${method} ${pathname}): ${response.status} ${text}`.trim());
    }

    return response;
  }
}

function normalizeQdrantPointId(id: string): string | number {
  if (/^\d+$/.test(id)) {
    return Number(id);
  }

  if (isUuid(id)) {
    return id.toLowerCase();
  }

  return deterministicUuidFromString(id);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function deterministicUuidFromString(value: string): string {
  const hash = createHash('sha1').update(value).digest('hex');
  const bytes = hash.slice(0, 32).split('');

  bytes[12] = '5';
  bytes[16] = ((parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);

  return [
    bytes.slice(0, 8).join(''),
    bytes.slice(8, 12).join(''),
    bytes.slice(12, 16).join(''),
    bytes.slice(16, 20).join(''),
    bytes.slice(20, 32).join(''),
  ].join('-');
}

interface QueryRow<RecordPayload extends Record<string, unknown>> {
  id: unknown;
  payload: RecordPayload;
  score?: number;
}

interface QueryResponse<RecordPayload extends Record<string, unknown>> {
  result?: {
    points?: Array<QueryRow<RecordPayload>>;
  } | Array<QueryRow<RecordPayload>>;
}

export function buildQdrantMatchFilter(key: string, value: string): Record<string, unknown> {
  return {
    must: [
      {
        key,
        match: { value },
      },
    ],
  };
}

export function buildQdrantFileFilter(
  repositoryId: string,
  filePath: string,
  recordType: string
): Record<string, unknown> {
  return {
    must: [
      {
        key: 'repositoryId',
        match: { value: repositoryId },
      },
      {
        key: 'recordType',
        match: { value: recordType },
      },
      {
        key: 'filePath',
        match: { value: filePath },
      },
    ],
  };
}
