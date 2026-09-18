import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  assertDistributionManifest,
  assertTrustedOwnershipList,
  createDistributionManifest,
  sha256Bytes,
  verifyManifestDigest,
} from './distribution-manifest.js';
import type { TrustedOwnershipEntry } from './distribution-manifest.js';

export interface VerifyDistributionManifestOptions {
  readonly manifest: unknown;
  readonly trustedOwnershipList: unknown;
  readonly sourceRoot: string;
  readonly expectedSourceRepository: string;
}

export interface DistributionVerificationResult {
  readonly sourceRepository: string;
  readonly sourceSha: string;
  readonly manifestDigest: string;
  readonly verifiedFileCount: number;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

function reject(message: string): never {
  throw new Error(`Distribution verification failed: ${message}`);
}

function inventoryKey(entry: TrustedOwnershipEntry): string {
  return JSON.stringify([entry.sourcePath, entry.targetPath, entry.classification]);
}

function assertPlainDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) reject(`not a plain directory: ${path}`);
}

function assertSourceAncestors(root: string, relativePath: string): string {
  assertPlainDirectory(root);
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    assertPlainDirectory(current);
  }
  const file = join(root, ...parts);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) reject('source path escaped sourceRoot');
  return file;
}

function readPlainSourceFile(root: string, relativePath: string): Buffer {
  const file = assertSourceAncestors(root, relativePath);
  const before = lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) reject(`source is not a regular file: ${relativePath}`);
  if (realpathSync(file) !== file) reject(`source has a symbolic path: ${relativePath}`);
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      reject(`source changed while opening: ${relativePath}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertSourceAncestors(root, relativePath);
    const finalPath = lstatSync(file);
    if (finalPath.isSymbolicLink() || !finalPath.isFile()
      || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || finalPath.size !== after.size || finalPath.mtimeMs !== after.mtimeMs || finalPath.ctimeMs !== after.ctimeMs
      || realpathSync(file) !== file) {
      reject(`source changed while reading: ${relativePath}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseTree(bytes: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0) reject('unterminated Git tree record');
    const record = bytes.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab < 0) reject('malformed Git tree record');
    const metadata = record.subarray(0, tab).toString('ascii');
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(metadata);
    if (!match) reject('malformed Git tree metadata');
    const mode = match[1];
    const type = match[2];
    const oid = match[3];
    if (mode === undefined || type === undefined || oid === undefined) reject('missing Git tree metadata');
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) reject('Git tree contains a non-UTF-8 path');
    if (entries.has(path)) reject('Git tree contains a duplicate path');
    entries.set(path, { mode, type, oid });
    start = end + 1;
  }
  return entries;
}

/**
 * Synchronous, local, read-only verification. All errors throw; no partial success.
 * The caller must supply independently trusted ownership and repository identity.
 */
export function verifyDistributionManifest(options: VerifyDistributionManifestOptions): DistributionVerificationResult {
  try {
    assertDistributionManifest(options.manifest);
    assertTrustedOwnershipList(options.trustedOwnershipList);
    if (!verifyManifestDigest(options.manifest)) reject('manifestDigest mismatch');
    // Copy after validation so later work does not rely on mutable caller objects.
    const manifest = createDistributionManifest({
      schemaVersion: options.manifest.schemaVersion,
      releaseLine: options.manifest.releaseLine,
      sourceRepository: options.manifest.sourceRepository,
      sourceSha: options.manifest.sourceSha,
      entries: options.manifest.entries,
    });
    const trusted = options.trustedOwnershipList;
    if (manifest.sourceRepository !== options.expectedSourceRepository
      || trusted.sourceRepository !== options.expectedSourceRepository) {
      reject('sourceRepository does not match independent expectedSourceRepository');
    }
    const trustedInventory = new Set(trusted.entries.map(inventoryKey));
    if (manifest.entries.length !== trustedInventory.size
      || manifest.entries.some(entry => !trustedInventory.has(inventoryKey(entry)))) {
      reject('manifest inventory does not exactly match trusted ownership');
    }
    if (typeof options.sourceRoot !== 'string' || !isAbsolute(options.sourceRoot)) {
      reject('sourceRoot must be an absolute directory path');
    }
    const root = resolve(options.sourceRoot);
    assertPlainDirectory(root);
    if (realpathSync(root) !== root) reject('sourceRoot must not contain symbolic links');
    // Discard inherited Git repository/config/object overrides. Never fetch, invoke
    // a shell, refresh the index, run filters, or use replacement objects.
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.toUpperCase().startsWith('GIT_')) environment[key] = value;
    }
    environment.GIT_OPTIONAL_LOCKS = '0';
    environment.GIT_NO_REPLACE_OBJECTS = '1';
    environment.GIT_NO_LAZY_FETCH = '1';
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const git = (args: readonly string[]): Buffer => execFileSync('git', [
      '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', root, ...args,
    ], {
      env: environment,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
    });
    const topLevel = git(['rev-parse', '--show-toplevel']).toString('utf8').trimEnd();
    if (resolve(topLevel) !== root || realpathSync(topLevel) !== root) reject('sourceRoot must be the Git worktree root');
    const readHead = (): string => git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
    if (readHead() !== manifest.sourceSha) reject('Git HEAD does not match full sourceSha');
    const tree = parseTree(git(['ls-tree', '-r', '-z', '--full-tree', manifest.sourceSha]));
    for (const entry of manifest.entries) {
      const tracked = tree.get(entry.sourcePath);
      if (!tracked || tracked.type !== 'blob' || (tracked.mode !== '100644' && tracked.mode !== '100755')) {
        reject(`source is not a regular commit-tree blob: ${entry.sourcePath}`);
      }
      const blob = git(['cat-file', 'blob', tracked.oid]);
      const actual = readPlainSourceFile(root, entry.sourcePath);
      if (!blob.equals(actual)) reject(`source bytes differ from commit-tree blob: ${entry.sourcePath}`);
      if (sha256Bytes(blob) !== entry.contentDigest || sha256Bytes(actual) !== entry.contentDigest) {
        reject(`contentDigest mismatch: ${entry.sourcePath}`);
      }
    }
    if (readHead() !== manifest.sourceSha) reject('Git HEAD changed during verification');
    return Object.freeze({
      sourceRepository: manifest.sourceRepository,
      sourceSha: manifest.sourceSha,
      manifestDigest: manifest.manifestDigest,
      verifiedFileCount: manifest.entries.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown verification error';
    throw new Error(`Read-only distribution verifier rejected input: ${message}`);
  }
}
