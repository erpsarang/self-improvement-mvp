import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  assertTrustedOwnershipList, canonicalSerializeManifest, createDistributionManifest, sha256Bytes,
} from './distribution-manifest.js';
import { verifyDistributionManifest } from './distribution-manifest-verifier.js';
import {
  canonicalOwnershipList, canonicalSerializeBundle, DISTRIBUTION_OWNERSHIP_PATH,
} from './distribution-bundle.js';
import type { DistributionBundle } from './distribution-bundle.js';
import { assertBundleDirectory, readBundleFile, verifyDistributionBundle } from './distribution-bundle-verifier.js';

export interface BuildDistributionBundleOptions {
  readonly sourceRoot: string;
  readonly releaseLine: string;
  readonly expectedSourceRepository: string;
  readonly sourceSha: string;
  readonly trustedOwnershipList: unknown;
  readonly outputRoot: string;
}

function assertAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${path}`);
}

/** No network acquisition, target installation, or source modification.
 * The output parent must already exist and be controlled by the caller, without
 * concurrent writers. Like the Phase 1 verifier, this is not an OS sandbox against
 * an adversary concurrently replacing directories. Full production generation needs
 * a commit that actually contains the authority and all new runtime files.
 */
export function buildDistributionBundle(options: BuildDistributionBundleOptions): DistributionBundle {
  assertTrustedOwnershipList(options.trustedOwnershipList);
  const trusted: unknown = JSON.parse(canonicalOwnershipList(options.trustedOwnershipList));
  assertTrustedOwnershipList(trusted);
  if (trusted.sourceRepository !== options.expectedSourceRepository) throw new Error('Independent repository mismatch');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.sourceSha)) throw new Error('Expected exact source SHA');
  assertBundleDirectory(options.sourceRoot);
  if (!isAbsolute(options.outputRoot) || resolve(options.outputRoot) !== options.outputRoot) throw new Error('Output must be an absolute normalized path');
  if (options.outputRoot === options.sourceRoot || options.outputRoot.startsWith(options.sourceRoot + sep)
    || options.sourceRoot.startsWith(options.outputRoot + sep)) throw new Error('Output and source roots must be disjoint');
  const parent = dirname(options.outputRoot);
  assertBundleDirectory(parent);
  assertAbsent(options.outputRoot);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  const git = (args: readonly string[]): Buffer => execFileSync('git', [
    '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', options.sourceRoot, ...args,
  ], { env: environment, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  if (git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim() !== options.sourceSha) throw new Error('Source SHA mismatch');
  const tree = new Map<string, { mode: string; type: string; oid: string }>();
  const records = git(['ls-tree', '-r', '-z', '--full-tree', options.sourceSha]);
  let offset = 0;
  while (offset < records.length) {
    const end = records.indexOf(0, offset);
    if (end < 0) throw new Error('Malformed tree record');
    const record = records.subarray(offset, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Malformed tree record');
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(record.subarray(0, tab).toString('ascii'));
    if (!match || !match[1] || !match[2] || !match[3]) throw new Error('Malformed tree metadata');
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(pathBytes) || tree.has(path)) throw new Error('Invalid tree path');
    tree.set(path, { mode: match[1], type: match[2], oid: match[3] });
    offset = end + 1;
  }
  const readBlob = (path: string): Buffer => {
    const entry = tree.get(path);
    if (!entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      throw new Error(`Missing regular source commit blob: ${path}`);
    }
    return git(['cat-file', 'blob', entry.oid]);
  };
  const authorityBytes = readBlob(DISTRIBUTION_OWNERSHIP_PATH);
  const authority: unknown = JSON.parse(authorityBytes.toString('utf8'));
  if (canonicalOwnershipList(authority) !== canonicalOwnershipList(trusted)
    || !readBundleFile(join(options.sourceRoot, DISTRIBUTION_OWNERSHIP_PATH)).equals(authorityBytes)) {
    throw new Error('Source ownership authority differs from independent trusted list or commit');
  }
  const manifest = createDistributionManifest({
    schemaVersion: 1,
    releaseLine: options.releaseLine,
    sourceRepository: options.expectedSourceRepository,
    sourceSha: options.sourceSha,
    entries: trusted.entries.map(entry => ({ ...entry, ownership: 'framework', contentDigest: sha256Bytes(readBlob(entry.sourcePath)) })),
  });
  verifyDistributionManifest({ manifest, trustedOwnershipList: trusted, sourceRoot: options.sourceRoot, expectedSourceRepository: options.expectedSourceRepository });
  const staging = mkdtempSync(join(parent, `.${basename(options.outputRoot)}.staging-`));
  try {
    mkdirSync(join(staging, 'payload'));
    writeFileSync(join(staging, 'manifest.json'), canonicalSerializeManifest(manifest), { encoding: 'utf8', flag: 'wx' });
    writeFileSync(join(staging, 'bundle.json'), canonicalSerializeBundle(manifest), { encoding: 'utf8', flag: 'wx' });
    for (const entry of manifest.entries) {
      const bytes = readBlob(entry.sourcePath);
      if (sha256Bytes(bytes) !== entry.contentDigest) throw new Error('Blob digest changed after manifest verification');
      const destination = join(staging, 'payload', ...entry.targetPath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      assertBundleDirectory(dirname(destination));
      writeFileSync(destination, bytes, { flag: 'wx' });
    }
    const result = verifyDistributionBundle({
      bundleRoot: staging, trustedOwnershipList: trusted,
      expectedReleaseLine: options.releaseLine, expectedSourceRepository: options.expectedSourceRepository,
      expectedSourceSha: options.sourceSha,
    });
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim() !== options.sourceSha) throw new Error('Source HEAD changed');
    assertBundleDirectory(parent);
    // Exclusive reservation prevents overwriting any pre-existing destination.
    // Rename exposes the verified tree atomically over our own empty reservation.
    mkdirSync(options.outputRoot);
    renameSync(staging, options.outputRoot);
    return result;
  } finally {
    // Never remove source, destination, another invocation's staging, or parent.
    rmSync(staging, { recursive: true, force: true });
  }
}
