import { createHash } from 'node:crypto';

export type DistributionClassification = 'required' | 'optional';

export interface TrustedOwnershipEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly classification: DistributionClassification;
}

export interface DistributionManifestEntry extends TrustedOwnershipEntry {
  readonly ownership: 'framework';
  readonly contentDigest: string;
}

export interface TrustedOwnershipList {
  readonly schemaVersion: 1;
  readonly sourceRepository: string;
  readonly entries: readonly TrustedOwnershipEntry[];
}

export interface DistributionManifestPayload {
  readonly schemaVersion: 1;
  readonly releaseLine: string;
  readonly sourceRepository: string;
  readonly sourceSha: string;
  readonly entries: readonly DistributionManifestEntry[];
}

export interface DistributionManifest extends DistributionManifestPayload {
  readonly manifestDigest: string;
}

// Scan across Unicode line separators as well as ordinary path characters.
const PATH_PATTERN = '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u0020\\u007f-\\u009f])(?![\\s\\S]*(?:^|/)[.]{1,2}(?:/|$))[^/]+(?:/[^/]+)*$';
const REPOSITORY_PATTERN = '^\\S(?:[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)?$';
const RELEASE_LINE_PATTERN = '^v(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$';
const SHA_PATTERN = '^(?:[0-9a-f]{40}|[0-9a-f]{64})$';
const DIGEST_PATTERN = '^[0-9a-f]{64}$';

const ownershipProperties = {
  sourcePath: { type: 'string', pattern: PATH_PATTERN },
  targetPath: { type: 'string', pattern: PATH_PATTERN },
  classification: { type: 'string', enum: ['required', 'optional'] },
} as const;

/** JSON Schema handles shape; validators also enforce unique source and target paths. */
export const trustedOwnershipListSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'sourceRepository', 'entries'],
  properties: {
    schemaVersion: { const: 1 },
    sourceRepository: { type: 'string', pattern: REPOSITORY_PATTERN },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourcePath', 'targetPath', 'classification'],
        properties: ownershipProperties,
      },
    },
  },
} as const;

export const distributionManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'releaseLine', 'sourceRepository', 'sourceSha', 'entries', 'manifestDigest'],
  properties: {
    schemaVersion: { const: 1 },
    sourceRepository: { type: 'string', pattern: REPOSITORY_PATTERN },
    releaseLine: { type: 'string', pattern: RELEASE_LINE_PATTERN },
    sourceSha: { type: 'string', pattern: SHA_PATTERN },
    manifestDigest: { type: 'string', pattern: DIGEST_PATTERN },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourcePath', 'targetPath', 'classification', 'ownership', 'contentDigest'],
        properties: {
          ...ownershipProperties,
          ownership: { const: 'framework' },
          contentDigest: { type: 'string', pattern: DIGEST_PATTERN },
        },
      },
    },
  },
} as const;

function fail(message: string): never {
  throw new Error(`Invalid distribution manifest contract: ${message}`);
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    return fail(`${label} has missing or additional properties`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function matches(value: unknown, pattern: string, label: string): asserts value is string {
  if (typeof value !== 'string' || !new RegExp(pattern, 'u').test(value)) {
    fail(`${label} has an invalid value`);
  }
}

export function assertSafeRelativePath(value: unknown): asserts value is string {
  matches(value, PATH_PATTERN, 'path');
}

function assertRepository(value: unknown): asserts value is string {
  matches(value, REPOSITORY_PATTERN, 'sourceRepository');
}

function assertEntries(value: unknown, withDigest: boolean): void {
  if (!Array.isArray(value)) fail('entries must be an array');
  // Accept only dense JSON arrays, without custom properties or accessors.
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('entries must be a dense JSON array');
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('invalid entries array element');
    const keys = withDigest
      ? ['sourcePath', 'targetPath', 'classification', 'ownership', 'contentDigest']
      : ['sourcePath', 'targetPath', 'classification'];
    const entry = exactObject(descriptor.value, keys, `entries[${index}]`);
    assertSafeRelativePath(entry.sourcePath);
    assertSafeRelativePath(entry.targetPath);
    if (entry.classification !== 'required' && entry.classification !== 'optional') {
      fail('classification must be required or optional');
    }
    if (withDigest) {
      if (entry.ownership !== 'framework') fail('ownership must be framework');
      matches(entry.contentDigest, DIGEST_PATTERN, 'contentDigest');
    }
    if (sources.has(entry.sourcePath)) fail(`duplicate sourcePath: ${entry.sourcePath}`);
    if (targets.has(entry.targetPath)) fail(`duplicate targetPath: ${entry.targetPath}`);
    sources.add(entry.sourcePath);
    targets.add(entry.targetPath);
  }
  // An inventory of files cannot also place a file beneath another file.
  for (const paths of [sources, targets]) {
    for (const path of paths) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        if (paths.has(parts.slice(0, index).join('/'))) fail(`file/directory path collision: ${path}`);
      }
    }
  }
}

export function assertTrustedOwnershipList(value: unknown): asserts value is TrustedOwnershipList {
  const list = exactObject(value, ['schemaVersion', 'sourceRepository', 'entries'], 'trustedOwnershipList');
  if (list.schemaVersion !== 1) fail('unsupported ownership schemaVersion');
  assertRepository(list.sourceRepository);
  assertEntries(list.entries, false);
}

export function assertDistributionManifestPayload(value: unknown): asserts value is DistributionManifestPayload {
  const payload = exactObject(value, ['schemaVersion', 'releaseLine', 'sourceRepository', 'sourceSha', 'entries'], 'payload');
  if (payload.schemaVersion !== 1) fail('unsupported manifest schemaVersion');
  matches(payload.releaseLine, RELEASE_LINE_PATTERN, 'releaseLine');
  assertRepository(payload.sourceRepository);
  matches(payload.sourceSha, SHA_PATTERN, 'sourceSha');
  assertEntries(payload.entries, true);
}

/** Structural validation only; use verifyManifestDigest for integrity validation. */
export function assertDistributionManifest(value: unknown): asserts value is DistributionManifest {
  const manifest = exactObject(value, ['schemaVersion', 'releaseLine', 'sourceRepository', 'sourceSha', 'entries', 'manifestDigest'], 'manifest');
  assertDistributionManifestPayload({
    schemaVersion: manifest.schemaVersion,
    releaseLine: manifest.releaseLine,
    sourceRepository: manifest.sourceRepository,
    sourceSha: manifest.sourceSha,
    entries: manifest.entries,
  });
  matches(manifest.manifestDigest, DIGEST_PATTERN, 'manifestDigest');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedPayload(payload: DistributionManifestPayload): DistributionManifestPayload {
  return {
    schemaVersion: 1,
    releaseLine: payload.releaseLine,
    sourceRepository: payload.sourceRepository,
    sourceSha: payload.sourceSha,
    entries: payload.entries.map(entry => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      classification: entry.classification,
      ownership: entry.ownership,
      contentDigest: entry.contentDigest,
    })).sort((left, right) =>
      compareText(left.sourcePath, right.sourcePath)
      || compareText(left.targetPath, right.targetPath)
      || compareText(left.classification, right.classification)
      || compareText(left.contentDigest, right.contentDigest)),
  };
}

function payloadOf(manifest: DistributionManifest): DistributionManifestPayload {
  return {
    schemaVersion: manifest.schemaVersion,
    releaseLine: manifest.releaseLine,
    sourceRepository: manifest.sourceRepository,
    sourceSha: manifest.sourceSha,
    entries: manifest.entries,
  };
}

/** UTF-8 JSON, fixed key order, code-unit lexical entry order, no final newline. */
export function canonicalSerializeManifestPayload(payload: DistributionManifestPayload): string {
  assertDistributionManifestPayload(payload);
  return JSON.stringify(orderedPayload(payload));
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function computeManifestDigest(payload: DistributionManifestPayload): string {
  return sha256Bytes(Buffer.from(canonicalSerializeManifestPayload(payload), 'utf8'));
}

/** Returns a detached, deeply frozen manifest. */
export function createDistributionManifest(payload: DistributionManifestPayload): DistributionManifest {
  assertDistributionManifestPayload(payload);
  const ordered = orderedPayload(payload);
  for (const entry of ordered.entries) Object.freeze(entry);
  Object.freeze(ordered.entries);
  return Object.freeze({ ...ordered, manifestDigest: computeManifestDigest(ordered) });
}

/** Malformed input throws; a well-formed but incorrect digest returns false. */
export function verifyManifestDigest(manifest: unknown): boolean {
  assertDistributionManifest(manifest);
  return computeManifestDigest(payloadOf(manifest)) === manifest.manifestDigest;
}

export function canonicalSerializeManifest(manifest: DistributionManifest): string {
  assertDistributionManifest(manifest);
  if (!verifyManifestDigest(manifest)) fail('manifestDigest mismatch');
  return JSON.stringify({ ...orderedPayload(payloadOf(manifest)), manifestDigest: manifest.manifestDigest });
}
