import {
  assertDistributionManifest, assertTrustedOwnershipList,
  canonicalSerializeManifest, sha256Bytes,
} from './distribution-manifest.js';
import type { DistributionManifest, TrustedOwnershipList } from './distribution-manifest.js';

export const DISTRIBUTION_OWNERSHIP_PATH = 'policy/framework-distribution-ownership.v1.json';
export const BUNDLE_KIND = 'framework-distribution-bundle';
export const BUNDLE_DIGEST_ALGORITHM = 'sha256';

export interface DistributionBundlePayload {
  readonly schemaVersion: 1;
  readonly kind: typeof BUNDLE_KIND;
  readonly digestAlgorithm: typeof BUNDLE_DIGEST_ALGORITHM;
  readonly releaseLine: string;
  readonly sourceRepository: string;
  readonly sourceSha: string;
  readonly manifestDigest: string;
  readonly entries: readonly { readonly targetPath: string; readonly contentDigest: string }[];
}

export interface DistributionBundle extends DistributionBundlePayload {
  readonly bundleDigest: string;
}

export function compareBundleText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic inventory identity; never derives ownership from a manifest or scan. */
export function canonicalOwnershipList(value: unknown): string {
  assertTrustedOwnershipList(value);
  return JSON.stringify({
    schemaVersion: 1,
    sourceRepository: value.sourceRepository,
    entries: value.entries.map(entry => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      classification: entry.classification,
    })).sort((a, b) => compareBundleText(a.sourcePath, b.sourcePath)),
  });
}

export function assertBundleInventory(manifest: DistributionManifest, trusted: TrustedOwnershipList): void {
  assertDistributionManifest(manifest);
  assertTrustedOwnershipList(trusted);
  if (canonicalOwnershipList({
    schemaVersion: 1,
    sourceRepository: manifest.sourceRepository,
    entries: manifest.entries.map(({ sourcePath, targetPath, classification }) => ({ sourcePath, targetPath, classification })),
  }) !== canonicalOwnershipList(trusted)) throw new Error('Bundle inventory does not match external trusted ownership');
}

/** Fixed keys, UTF-8 JSON, code-unit target order, no whitespace or final newline.
 * Digest preimage is precisely this JSON without bundleDigest. Constants domain
 * separate the format; no transport, time, filesystem, or permission metadata enters it.
 */
export function canonicalSerializeBundlePayload(manifest: DistributionManifest): string {
  canonicalSerializeManifest(manifest);
  const payload: DistributionBundlePayload = {
    schemaVersion: 1,
    kind: BUNDLE_KIND,
    digestAlgorithm: BUNDLE_DIGEST_ALGORITHM,
    releaseLine: manifest.releaseLine,
    sourceRepository: manifest.sourceRepository,
    sourceSha: manifest.sourceSha,
    manifestDigest: manifest.manifestDigest,
    entries: manifest.entries.map(({ targetPath, contentDigest }) => ({ targetPath, contentDigest }))
      .sort((a, b) => compareBundleText(a.targetPath, b.targetPath)),
  };
  return JSON.stringify(payload);
}

export function computeBundleDigest(manifest: DistributionManifest): string {
  return sha256Bytes(Buffer.from(canonicalSerializeBundlePayload(manifest), 'utf8'));
}

export function createDistributionBundle(manifest: DistributionManifest): DistributionBundle {
  const payload = JSON.parse(canonicalSerializeBundlePayload(manifest)) as DistributionBundlePayload;
  for (const entry of payload.entries) Object.freeze(entry);
  Object.freeze(payload.entries);
  return Object.freeze({ ...payload, bundleDigest: computeBundleDigest(manifest) });
}

export function canonicalSerializeBundle(manifest: DistributionManifest): string {
  return JSON.stringify(createDistributionBundle(manifest));
}
