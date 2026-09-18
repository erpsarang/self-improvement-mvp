import {
  constants, closeSync, fstatSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  assertDistributionManifest, assertSafeRelativePath, assertTrustedOwnershipList,
  canonicalSerializeManifest, sha256Bytes,
} from './distribution-manifest.js';
import {
  assertBundleInventory, canonicalOwnershipList, canonicalSerializeBundle,
  createDistributionBundle, DISTRIBUTION_OWNERSHIP_PATH,
} from './distribution-bundle.js';
import type { DistributionBundle } from './distribution-bundle.js';

export interface VerifyDistributionBundleOptions {
  readonly bundleRoot: string;
  readonly trustedOwnershipList: unknown;
  readonly expectedReleaseLine: string;
  readonly expectedSourceRepository: string;
  readonly expectedSourceSha: string;
}

/** Checks every existing ancestor, including ancestors above the bundle root. */
export function assertBundleDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Directory must be an absolute normalized path');
  const parent = dirname(path);
  if (parent !== path) assertBundleDirectory(parent);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`Not a plain directory: ${path}`);
  }
}

export function readBundleFile(path: string): Buffer {
  assertBundleDirectory(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Not a regular file: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('File changed while opening');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    assertBundleDirectory(dirname(path));
    const final = lstatSync(path);
    if (!final.isFile() || final.isSymbolicLink() || final.dev !== opened.dev || final.ino !== opened.ino
      || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs
      || realpathSync(path) !== path) throw new Error('File changed while reading');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Local consistency verification. Authority and expected provenance come from the caller,
 * never from payload ownership metadata or archive metadata. All errors throw.
 */
export function verifyDistributionBundle(options: VerifyDistributionBundleOptions): DistributionBundle {
  assertTrustedOwnershipList(options.trustedOwnershipList);
  const trusted = JSON.parse(canonicalOwnershipList(options.trustedOwnershipList)) as unknown;
  assertTrustedOwnershipList(trusted);
  assertBundleDirectory(options.bundleRoot);
  const manifestBytes = readBundleFile(join(options.bundleRoot, 'manifest.json'));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  assertDistributionManifest(manifest);
  if (!manifestBytes.equals(Buffer.from(canonicalSerializeManifest(manifest), 'utf8'))) {
    throw new Error('Noncanonical manifest bytes or manifest digest mismatch');
  }
  if (manifest.releaseLine !== options.expectedReleaseLine
    || manifest.sourceRepository !== options.expectedSourceRepository
    || trusted.sourceRepository !== options.expectedSourceRepository
    || manifest.sourceSha !== options.expectedSourceSha) throw new Error('Bundle provenance mismatch');
  assertBundleInventory(manifest, trusted);
  const metadataBytes = readBundleFile(join(options.bundleRoot, 'bundle.json'));
  // Reconstruct the complete expected metadata, including its independently recomputed
  // digest. Exact byte equality rejects unknown fields, duplicate JSON keys, reordering,
  // transport metadata, and every manifest/metadata identity mismatch.
  if (!metadataBytes.equals(Buffer.from(canonicalSerializeBundle(manifest), 'utf8'))) {
    throw new Error('Bundle metadata, canonical bytes, or bundle digest mismatch');
  }
  const expectedFiles = new Map(manifest.entries.map(entry => [`payload/${entry.targetPath}`, entry]));
  const directories = new Set<string>(['payload']);
  for (const path of expectedFiles.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set<string>();
  const walk = (relative: string): void => {
    const directory = relative ? join(options.bundleRoot, relative) : options.bundleRoot;
    assertBundleDirectory(directory);
    for (const name of readdirSync(directory)) {
      assertSafeRelativePath(name);
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(options.bundleRoot, path);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Bundle contains a symbolic link');
      if (stat.isDirectory()) {
        if (!directories.has(path)) throw new Error(`Extra bundle directory: ${path}`);
        seen.add(path);
        walk(path);
      } else {
        if (!stat.isFile()) throw new Error(`Nonregular bundle entry: ${path}`);
        if (path === 'manifest.json' || path === 'bundle.json') continue;
        const entry = expectedFiles.get(path);
        if (!entry) throw new Error(`Extra payload file: ${path}`);
        const bytes = readBundleFile(absolute);
        if (sha256Bytes(bytes) !== entry.contentDigest) throw new Error(`Payload content digest mismatch: ${path}`);
        if (entry.sourcePath === DISTRIBUTION_OWNERSHIP_PATH) {
          const embedded: unknown = JSON.parse(bytes.toString('utf8'));
          if (canonicalOwnershipList(embedded) !== canonicalOwnershipList(trusted)) throw new Error('Payload ownership copy mismatch');
        }
        seen.add(path);
      }
    }
  };
  walk('');
  for (const path of [...directories, ...expectedFiles.keys()]) {
    if (!seen.has(path)) throw new Error(`Missing bundle entry: ${path}`);
  }
  // Detect metadata replacement during payload verification as well.
  if (!readBundleFile(join(options.bundleRoot, 'manifest.json')).equals(manifestBytes)
    || !readBundleFile(join(options.bundleRoot, 'bundle.json')).equals(metadataBytes)) throw new Error('Bundle metadata changed during verification');
  return createDistributionBundle(manifest);
}
