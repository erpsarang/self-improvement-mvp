import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assertDistributionManifest, createDistributionManifest, sha256Bytes,
} from '../src/self-improvement/distribution-manifest.js';
import type { TrustedOwnershipList } from '../src/self-improvement/distribution-manifest.js';
import {
  canonicalSerializeBundlePayload, computeBundleDigest, DISTRIBUTION_OWNERSHIP_PATH,
} from '../src/self-improvement/distribution-bundle.js';
import { buildDistributionBundle } from '../src/self-improvement/distribution-bundle-builder.js';
import { verifyDistributionBundle } from '../src/self-improvement/distribution-bundle-verifier.js';

const repository = 'erpsarang/self-improvement-mvp';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'distribution-phase2-')));
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  const trusted: TrustedOwnershipList = {
    schemaVersion: 1, sourceRepository: repository,
    entries: [
      { sourcePath: 'runtime/b.bin', targetPath: 'lib/z.bin', classification: 'required' },
      { sourcePath: 'runtime/a.txt', targetPath: 'lib/a.txt', classification: 'required' },
      { sourcePath: DISTRIBUTION_OWNERSHIP_PATH, targetPath: DISTRIBUTION_OWNERSHIP_PATH, classification: 'required' },
    ],
  };
  const write = (path: string, bytes: string | Buffer) => {
    const destination = join(sourceRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  };
  write('runtime/b.bin', Buffer.from([0, 255, 13, 10, 128]));
  write('runtime/a.txt', 'exact\r\nbytes\n');
  write(DISTRIBUTION_OWNERSHIP_PATH, JSON.stringify(trusted, null, 2) + '\n');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (...args: string[]) => execFileSync('git', ['-C', sourceRoot, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Bundle Fixture', '-c', 'user.email=bundle@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const sourceSha = commit();
  const build = (outputRoot = join(root, 'bundle')) => buildDistributionBundle({
    sourceRoot, releaseLine: 'v0.3', expectedSourceRepository: repository, sourceSha, trustedOwnershipList: trusted, outputRoot,
  });
  const verify = (bundleRoot = join(root, 'bundle')) => verifyDistributionBundle({
    bundleRoot, trustedOwnershipList: trusted, expectedReleaseLine: 'v0.3', expectedSourceRepository: repository, expectedSourceSha: sourceSha,
  });
  return { root, sourceRoot, sourceSha, trusted, write, commit, build, verify };
}

test('fixed UTF-8 digest and explicit canonical bundle preimage vector', () => {
  assert.equal(sha256Bytes(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const manifestPreimage = '{"schemaVersion":1,"releaseLine":"v0.3","sourceRepository":"example/framework","sourceSha":"1111111111111111111111111111111111111111","entries":[]}';
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const manifest = createDistributionManifest({ schemaVersion: 1, releaseLine: 'v0.3', sourceRepository: 'example/framework', sourceSha: '1'.repeat(40), entries: [] });
  assert.equal(manifest.manifestDigest, hash(manifestPreimage));
  const preimage = '{"schemaVersion":1,"kind":"framework-distribution-bundle","digestAlgorithm":"sha256","releaseLine":"v0.3","sourceRepository":"example/framework","sourceSha":"1111111111111111111111111111111111111111","manifestDigest":"' + hash(manifestPreimage) + '","entries":[]}';
  assert.equal(canonicalSerializeBundlePayload(manifest), preimage);
  assert.equal(computeBundleDigest(manifest), hash(preimage));
});

test('exact binary payload, deterministic identity, and verification without source', () => {
  const f = fixture();
  try {
    const first = f.build();
    const secondRoot = join(f.root, 'other');
    const second = buildDistributionBundle({ sourceRoot: f.sourceRoot, releaseLine: 'v0.3', expectedSourceRepository: repository, sourceSha: f.sourceSha, trustedOwnershipList: { ...f.trusted, entries: [...f.trusted.entries].reverse() }, outputRoot: secondRoot });
    assert.deepEqual(first, second);
    assert.deepEqual(first.entries.map(entry => entry.targetPath), [...first.entries.map(entry => entry.targetPath)].sort());
    for (const name of ['manifest.json', 'bundle.json']) assert.deepEqual(readFileSync(join(f.root, 'bundle', name)), readFileSync(join(secondRoot, name)));
    assert.deepEqual(readFileSync(join(f.root, 'bundle/payload/lib/z.bin')), Buffer.from([0, 255, 13, 10, 128]));
    utimesSync(join(f.root, 'bundle/payload/lib/z.bin'), new Date(0), new Date(0));
    renameSync(f.sourceRoot, join(f.root, 'source-unavailable'));
    assert.deepEqual(f.verify(), first);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const mutations: Record<string, (root: string) => void> = {
  'payload tamper': root => writeFileSync(join(root, 'payload/lib/z.bin'), 'tampered'),
  'payload missing': root => rmSync(join(root, 'payload/lib/a.txt')),
  'extra payload': root => writeFileSync(join(root, 'payload/extra'), 'extra'),
  'extra empty directory': root => mkdirSync(join(root, 'payload/extra')),
  'extra root file': root => writeFileSync(join(root, 'archive-metadata.json'), '{}'),
  'manifest noncanonical': root => writeFileSync(join(root, 'manifest.json'), readFileSync(join(root, 'manifest.json'), 'utf8') + '\n'),
  'metadata noncanonical': root => writeFileSync(join(root, 'bundle.json'), readFileSync(join(root, 'bundle.json'), 'utf8') + '\n'),
  'metadata missing': root => rmSync(join(root, 'bundle.json')),
  'manifest missing': root => rmSync(join(root, 'manifest.json')),
  'payload symlink': root => { rmSync(join(root, 'payload/lib/a.txt')); symlinkSync('z.bin', join(root, 'payload/lib/a.txt')); },
  'directory symlink': root => { renameSync(join(root, 'payload/lib'), join(root, 'payload/other')); symlinkSync('other', join(root, 'payload/lib'), 'dir'); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const f = fixture();
    try { f.build(); mutate(join(f.root, 'bundle')); assert.throws(() => f.verify()); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const field of ['bundleDigest', 'manifestDigest', 'sourceSha', 'sourceRepository', 'releaseLine', 'entries', 'transport']) {
  test(`rejects metadata ${field} mismatch`, () => {
    const f = fixture();
    try {
      f.build();
      const path = join(f.root, 'bundle/bundle.json');
      const metadata = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      metadata[field] = field === 'entries' ? [] : 'wrong';
      writeFileSync(path, JSON.stringify(metadata));
      assert.throws(() => f.verify());
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('rejects manifest digest tamper, duplicate, traversal, prefix collision and ownership mismatch', () => {
  const f = fixture();
  try {
    f.build();
    const path = join(f.root, 'bundle/manifest.json');
    const original = readFileSync(path, 'utf8');
    const valid: unknown = JSON.parse(original);
    assertDistributionManifest(valid);
    writeFileSync(path, original.replace(valid.manifestDigest, '0'.repeat(64)));
    assert.throws(() => f.verify());
    writeFileSync(path, original);
    const first = valid.entries[0];
    assert.ok(first);
    for (const entries of [
      [...valid.entries, first],
      [{ ...first, targetPath: '../escape' }],
      [{ ...first, targetPath: '/absolute' }],
      [{ ...first, targetPath: 'a\\b' }],
      [{ ...first, targetPath: 'a' }, { ...first, sourcePath: 'different', targetPath: 'a/b' }],
    ]) {
      writeFileSync(path, JSON.stringify({ ...valid, entries }));
      assert.throws(() => f.verify());
    }
    writeFileSync(path, original);
    for (const entries of [f.trusted.entries.slice(1), [...f.trusted.entries, { sourcePath: 'injected', targetPath: 'injected', classification: 'required' as const }]]) {
      assert.throws(() => verifyDistributionBundle({ bundleRoot: join(f.root, 'bundle'), trustedOwnershipList: { ...f.trusted, entries }, expectedReleaseLine: 'v0.3', expectedSourceRepository: repository, expectedSourceSha: f.sourceSha }));
    }
    for (const override of [{ expectedReleaseLine: 'v0.4' }, { expectedSourceRepository: 'wrong/repo' }, { expectedSourceSha: '0'.repeat(40) }]) {
      assert.throws(() => verifyDistributionBundle({ bundleRoot: join(f.root, 'bundle'), trustedOwnershipList: f.trusted, expectedReleaseLine: 'v0.3', expectedSourceRepository: repository, expectedSourceSha: f.sourceSha, ...override }));
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('builder rejects dirty bytes, stale source, authority mismatch, and unsafe output without overwriting', () => {
  const f = fixture();
  try {
    const options = { sourceRoot: f.sourceRoot, releaseLine: 'v0.3', expectedSourceRepository: repository, sourceSha: f.sourceSha, trustedOwnershipList: f.trusted, outputRoot: join(f.root, 'bundle') };
    assert.throws(() => buildDistributionBundle({ ...options, sourceSha: '0'.repeat(40) }));
    assert.throws(() => buildDistributionBundle({ ...options, expectedSourceRepository: 'wrong/repo' }));
    assert.throws(() => buildDistributionBundle({ ...options, trustedOwnershipList: { ...f.trusted, entries: f.trusted.entries.slice(1) } }));
    assert.throws(() => f.build(join(f.sourceRoot, 'output')));
    mkdirSync(join(f.root, 'existing'));
    writeFileSync(join(f.root, 'existing/keep'), 'keep');
    assert.throws(() => f.build(join(f.root, 'existing')));
    assert.equal(readFileSync(join(f.root, 'existing/keep'), 'utf8'), 'keep');
    symlinkSync(f.root, join(f.root, 'alias'), 'dir');
    assert.throws(() => f.build(join(f.root, 'alias/out')));
    symlinkSync('absent', join(f.root, 'dangling'));
    assert.throws(() => f.build(join(f.root, 'dangling')));
    f.write('runtime/a.txt', 'dirty');
    assert.throws(() => f.build());
    assert.equal(existsSync(options.outputRoot), false);
    f.write('runtime/a.txt', 'exact\r\nbytes\n');
    f.write(DISTRIBUTION_OWNERSHIP_PATH, JSON.stringify({ ...f.trusted, entries: [] }));
    assert.throws(() => f.build());
    f.commit();
    assert.throws(() => f.build());
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('builder rejects committed symlink payload and absent self-hosting runtime', () => {
  const f = fixture();
  try {
    rmSync(join(f.sourceRoot, 'runtime/a.txt'));
    symlinkSync('b.bin', join(f.sourceRoot, 'runtime/a.txt'));
    const sha = f.commit();
    assert.throws(() => buildDistributionBundle({ sourceRoot: f.sourceRoot, releaseLine: 'v0.3', expectedSourceRepository: repository, sourceSha: sha, trustedOwnershipList: f.trusted, outputRoot: join(f.root, 'bundle') }));
    const missing: TrustedOwnershipList = { ...f.trusted, entries: [...f.trusted.entries, { sourcePath: 'src/self-improvement/distribution-bundle.ts', targetPath: 'src/self-improvement/distribution-bundle.ts', classification: 'required' }] };
    f.write(DISTRIBUTION_OWNERSHIP_PATH, JSON.stringify(missing));
    const nextSha = f.commit();
    assert.throws(() => buildDistributionBundle({ sourceRoot: f.sourceRoot, releaseLine: 'v0.3', expectedSourceRepository: repository, sourceSha: nextSha, trustedOwnershipList: missing, outputRoot: join(f.root, 'bundle') }));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
