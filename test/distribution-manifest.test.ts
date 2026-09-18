import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDistributionManifest,
  assertSafeRelativePath,
  assertTrustedOwnershipList,
  canonicalSerializeManifest,
  canonicalSerializeManifestPayload,
  computeManifestDigest,
  createDistributionManifest,
  distributionManifestSchema,
  sha256Bytes,
  trustedOwnershipListSchema,
  verifyManifestDigest,
} from '../src/self-improvement/distribution-manifest.js';
import type { DistributionManifestPayload, TrustedOwnershipList } from '../src/self-improvement/distribution-manifest.js';
import { verifyDistributionManifest } from '../src/self-improvement/distribution-manifest-verifier.js';

const REPOSITORY = 'fixture/framework';
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FIXED_SHA = '0123456789abcdef0123456789abcdef01234567';
const FIXED_CANONICAL = '{"schemaVersion":1,"releaseLine":"v0.3","sourceRepository":"fixture/framework","sourceSha":"0123456789abcdef0123456789abcdef01234567","entries":[{"sourcePath":"empty.txt","targetPath":"framework/empty.txt","classification":"required","ownership":"framework","contentDigest":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}';
// The expected identity is derived solely from a fixed literal, independently of
// the production serializer and its digest helper.
const FIXED_MANIFEST_DIGEST = createHash('sha256').update(FIXED_CANONICAL, 'utf8').digest('hex');

function fixedPayload(): DistributionManifestPayload {
  return {
    schemaVersion: 1,
    sourceRepository: REPOSITORY,
    releaseLine: 'v0.3',
    sourceSha: FIXED_SHA,
    entries: [{ sourcePath: 'empty.txt', targetPath: 'framework/empty.txt', classification: 'required', ownership: 'framework', contentDigest: EMPTY_DIGEST }],
  };
}

function fixtureGit(root: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00+00:00';
  env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00+00:00';
  return execFileSync('git', ['-C', root, '-c', 'user.name=Manifest Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface Fixture {
  readonly root: string;
  readonly trusted: TrustedOwnershipList;
  readonly payload: DistributionManifestPayload;
}

function withFixture(run: (fixture: Fixture) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'distribution-manifest-')));
  try {
    fixtureGit(root, ['init', '--object-format=sha1']);
    mkdirSync(join(root, 'assets'));
    const binary = Buffer.from([0, 255, 254, 13, 10, 128, 0]);
    writeFileSync(join(root, 'assets', 'bytes.bin'), binary);
    writeFileSync(join(root, 'empty.txt'), Buffer.alloc(0));
    writeFileSync(join(root, '.gitattributes'), '* -text\n');
    fixtureGit(root, ['add', '--', '.']);
    fixtureGit(root, ['commit', '-m', 'fixture']);
    const trusted: TrustedOwnershipList = {
      schemaVersion: 1,
      sourceRepository: REPOSITORY,
      entries: [
        { sourcePath: 'assets/bytes.bin', targetPath: 'framework/bytes.bin', classification: 'required' },
        { sourcePath: 'empty.txt', targetPath: 'examples/empty.txt', classification: 'optional' },
      ],
    };
    const payload: DistributionManifestPayload = {
      schemaVersion: 1,
      sourceRepository: REPOSITORY,
      releaseLine: 'v0.3',
      sourceSha: fixtureGit(root, ['rev-parse', 'HEAD']),
      entries: trusted.entries.map(entry => ({
        ...entry,
        ownership: 'framework',
        contentDigest: sha256Bytes(readFileSync(join(root, entry.sourcePath))),
      })),
    };
    run({ root, trusted, payload });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verify(fixture: Fixture, payload = fixture.payload, trusted = fixture.trusted) {
  return verifyDistributionManifest({
    manifest: createDistributionManifest(payload),
    trustedOwnershipList: trusted,
    sourceRoot: fixture.root,
    expectedSourceRepository: REPOSITORY,
  });
}

function snapshot(root: string): readonly string[] {
  const result: string[] = [];
  const visit = (relative: string): void => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      result.push(`${relative}:link:${readlinkSync(path)}`);
    } else if (stat.isDirectory()) {
      result.push(`${relative}:directory:${stat.mode}`);
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    } else {
      result.push(`${relative}:file:${stat.mode}:${stat.size}:${stat.mtimeMs}:${sha256Bytes(readFileSync(path))}`);
    }
  };
  visit('');
  return result;
}

test('fixed canonical payload and SHA-256 expectations exclude manifestDigest', () => {
  const payload = fixedPayload();
  assert.equal(sha256Bytes(Buffer.alloc(0)), EMPTY_DIGEST);
  assert.equal(canonicalSerializeManifestPayload(payload), FIXED_CANONICAL);
  assert.equal(computeManifestDigest(payload), FIXED_MANIFEST_DIGEST);
  const manifest = createDistributionManifest(payload);
  assert.equal(manifest.manifestDigest, FIXED_MANIFEST_DIGEST);
  assert.equal(canonicalSerializeManifest(manifest), FIXED_CANONICAL.slice(0, -1) + ',"manifestDigest":"' + FIXED_MANIFEST_DIGEST + '"}');
  assert.equal(verifyManifestDigest(manifest), true);
  assert.equal(verifyManifestDigest({ ...manifest, manifestDigest: '0'.repeat(64) }), false);
  assert.throws(() => canonicalSerializeManifest({ ...manifest, manifestDigest: '0'.repeat(64) }));
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.entries));
  assert.ok(Object.isFrozen(manifest.entries[0]));
});

test('entry order and object insertion order do not affect canonical identity', () => {
  const first = fixedPayload().entries[0]!;
  const second = { ...first, sourcePath: 'Z.txt', targetPath: 'framework/Z.txt', classification: 'optional' as const };
  const payload = { ...fixedPayload(), entries: [first, second] };
  const reordered: DistributionManifestPayload = {
    entries: [second, first].map(entry => ({
      ownership: entry.ownership,
      contentDigest: entry.contentDigest,
      classification: entry.classification,
      targetPath: entry.targetPath,
      sourcePath: entry.sourcePath,
    })),
    releaseLine: payload.releaseLine,
    sourceSha: payload.sourceSha,
    sourceRepository: payload.sourceRepository,
    schemaVersion: 1,
  };
  assert.equal(computeManifestDigest(payload), computeManifestDigest(reordered));
  assert.equal(createDistributionManifest(payload).entries[0]!.sourcePath, 'Z.txt');
  assert.equal(payload.entries[0], first);
  for (const changed of [
    { ...payload, releaseLine: 'v0.4' },
    { ...payload, sourceRepository: 'another/framework' },
    { ...payload, sourceSha: 'f'.repeat(40) },
    { ...payload, entries: [{ ...first, targetPath: 'other.txt' }, second] },
    { ...payload, entries: [{ ...first, classification: 'optional' as const }, second] },
    { ...payload, entries: [{ ...first, contentDigest: 'a'.repeat(64) }, second] },
  ]) assert.notEqual(computeManifestDigest(payload), computeManifestDigest(changed));
});

test('schemas and runtime validators reject malformed shapes and additional properties', () => {
  assert.equal(distributionManifestSchema.additionalProperties, false);
  assert.equal(distributionManifestSchema.properties.entries.items.additionalProperties, false);
  assert.equal(trustedOwnershipListSchema.additionalProperties, false);
  assert.equal(trustedOwnershipListSchema.properties.entries.items.additionalProperties, false);
  const valid = createDistributionManifest(fixedPayload());
  for (const candidate of [
    null, [], {}, { ...valid, timestamp: 'today' }, { ...valid, compatibility: {} },
    { ...valid, schemaVersion: 2 }, { ...valid, sourceSha: 'abcdef0' },
    { ...valid, sourceSha: 'A'.repeat(40) }, { ...valid, manifestDigest: 'ABC' },
    { ...valid, sourceRepository: '' }, { ...valid, sourceRepository: ' fixture/framework' },
    { ...valid, entries: [{ ...valid.entries[0], extra: true }] },
    { ...valid, entries: [{ ...valid.entries[0], classification: 'unknown' }] },
    { ...valid, entries: [{ ...valid.entries[0], contentDigest: '0' }] },
    { ...valid, entries: new Array(1) },
  ]) assert.throws(() => assertDistributionManifest(candidate));
  const trusted = { schemaVersion: 1, sourceRepository: REPOSITORY, entries: [{ sourcePath: 'a', targetPath: 'b', classification: 'required' }] };
  assert.doesNotThrow(() => assertTrustedOwnershipList(trusted));
  assert.throws(() => assertTrustedOwnershipList({ ...trusted, entries: valid.entries }));
  assert.throws(() => assertTrustedOwnershipList({ ...trusted, extra: true }));
  assert.throws(() => assertDistributionManifest(Object.defineProperty({ ...valid }, 'sourceSha', { get: () => FIXED_SHA })));
});


test('release line and framework ownership are mandatory contract fields', () => {
  const payload = fixedPayload();
  const manifest = createDistributionManifest(payload);
  const { releaseLine: omittedLine, ...missingLine } = manifest;
  const { ownership: omittedOwnership, ...missingOwnership } = manifest.entries[0]!;
  assert.throws(() => assertDistributionManifest(missingLine));
  assert.throws(() => assertDistributionManifest({ ...manifest, entries: [missingOwnership] }));
  for (const releaseLine of [undefined, null, 3, '', 'v0', '0.3', 'v0.3.0', 'v01.3', 'v0.03', ' v0.3', 'v0.3\n']) {
    assert.throws(() => assertDistributionManifest({ ...manifest, releaseLine }));
    assert.throws(() => canonicalSerializeManifestPayload({ ...payload, releaseLine } as DistributionManifestPayload));
  }
  for (const ownership of [undefined, null, 1, '', 'project', 'Framework']) {
    const entries = [{ ...payload.entries[0]!, ownership }];
    assert.throws(() => assertDistributionManifest({ ...manifest, entries }));
    assert.throws(() => canonicalSerializeManifestPayload({ ...payload, entries } as DistributionManifestPayload));
  }
  assert.equal(verifyManifestDigest({ ...manifest, releaseLine: 'v0.4' }), false);
  assert.ok(distributionManifestSchema.required.includes('releaseLine'));
  assert.ok(distributionManifestSchema.properties.entries.items.required.includes('ownership'));
  assert.equal(distributionManifestSchema.properties.entries.items.properties.ownership.const, 'framework');
  const releasePattern = new RegExp(distributionManifestSchema.properties.releaseLine.pattern, 'u');
  assert.equal(releasePattern.test('v0.3'), true);
  assert.equal(releasePattern.test('v0.3.0'), false);
});

test('unsafe source and target paths, duplicate mappings, and prefix collisions fail closed', () => {
  const payload = fixedPayload();
  for (const path of ['', '/a', '../a', 'a/../b', './a', 'a/./b', 'a//b', 'a/', 'C:/a', 'a\\b', 'a\u0000b', 'a\nb', 'a b']) {
    assert.throws(() => assertSafeRelativePath(path), path);
    for (const field of ['sourcePath', 'targetPath']) {
      assert.throws(() => createDistributionManifest({ ...payload, entries: [{ ...payload.entries[0]!, [field]: path }] }), `${field}: ${path}`);
    }
  }
  const first = payload.entries[0]!;
  for (const second of [
    first,
    { ...first, targetPath: 'other.txt' },
    { ...first, sourcePath: 'other.txt' },
    { ...first, sourcePath: 'empty.txt/child', targetPath: 'other.txt' },
    { ...first, sourcePath: 'other.txt', targetPath: 'framework/empty.txt/child' },
  ]) assert.throws(() => createDistributionManifest({ ...payload, entries: [first, second] }));
  assert.throws(() => assertTrustedOwnershipList({ schemaVersion: 1, sourceRepository: REPOSITORY, entries: [
    { sourcePath: 'a', targetPath: 'b', classification: 'required' },
    { sourcePath: 'a', targetPath: 'c', classification: 'optional' },
  ] }));
});

test('Unicode line separators cannot hide forbidden characters or dot segments', () => {
  const payload = fixedPayload();
  for (const separator of ['\u2028', '\u2029']) {
    assert.doesNotThrow(() => assertSafeRelativePath(`safe${separator}/file.txt`));
    for (const suffix of ['/../../escape.txt', '/../escape.txt', '/./file.txt', '/..', '/.', '/bad:part', '/bad\\part', '/bad\u0000part', '/bad part', '/bad\npart']) {
      const path = `safe${separator}${suffix}`;
      assert.throws(() => assertSafeRelativePath(path), /path has an invalid value/);
      for (const field of ['sourcePath', 'targetPath'] as const) {
        const entries = [{ ...payload.entries[0]!, [field]: path }];
        assert.throws(() => createDistributionManifest({ ...payload, entries }), /path has an invalid value/);
        const trusted = {
          schemaVersion: 1, sourceRepository: REPOSITORY,
          entries: entries.map(({ sourcePath, targetPath, classification }) => ({ sourcePath, targetPath, classification })),
        };
        assert.throws(() => assertTrustedOwnershipList(trusted), /path has an invalid value/);
        for (const schema of [distributionManifestSchema, trustedOwnershipListSchema]) {
          assert.equal(new RegExp(schema.properties.entries.items.properties[field].pattern, 'u').test(path), false);
        }
      }
    }
  }
});

test('verifier rejects Unicode-hidden traversal even with matching trusted inventory and digest', () => {
  withFixture(fixture => {
    for (const separator of ['\u2028', '\u2029']) {
      for (const field of ['sourcePath', 'targetPath'] as const) {
        const payload = {
          ...fixture.payload,
          entries: fixture.payload.entries.map(entry => ({ ...entry, [field]: `safe${separator}/../../${entry.sourcePath}` })),
        };
        // Build the hostile input independently, bypassing the validating constructor.
        const manifestDigest = createHash('sha256').update(JSON.stringify({
          schemaVersion: payload.schemaVersion, releaseLine: payload.releaseLine,
          sourceRepository: payload.sourceRepository, sourceSha: payload.sourceSha, entries: payload.entries,
        }), 'utf8').digest('hex');
        const trusted = {
          ...fixture.trusted,
          entries: payload.entries.map(({ sourcePath, targetPath, classification }) => ({ sourcePath, targetPath, classification })),
        };
        assert.throws(() => verifyDistributionManifest({
          manifest: { ...payload, manifestDigest }, trustedOwnershipList: trusted,
          sourceRoot: fixture.root, expectedSourceRepository: REPOSITORY,
        }), /path has an invalid value/);
      }
    }
  });
});

test('verifies exact binary and empty bytes without changing the checkout or Git metadata', () => {
  withFixture(fixture => {
    const before = snapshot(fixture.root);
    const result = verify(fixture);
    assert.equal(result.verifiedFileCount, 2);
    assert.equal(result.sourceSha, fixture.payload.sourceSha);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(snapshot(fixture.root), before);
    assert.equal(fixtureGit(fixture.root, ['status', '--porcelain']), '');
  });
});

test('independent repository identity and actual full HEAD are mandatory', () => {
  withFixture(fixture => {
    assert.throws(() => verify(fixture, { ...fixture.payload, sourceSha: 'f'.repeat(40) }), /HEAD/);
    assert.throws(() => verify(fixture, { ...fixture.payload, sourceRepository: 'other/framework' }), /sourceRepository/);
    assert.throws(() => verify(fixture, fixture.payload, { ...fixture.trusted, sourceRepository: 'other/framework' }), /sourceRepository/);
    assert.throws(() => verifyDistributionManifest({
      manifest: createDistributionManifest(fixture.payload), trustedOwnershipList: fixture.trusted,
      sourceRoot: fixture.root, expectedSourceRepository: 'other/framework',
    }), /sourceRepository/);
    assert.throws(() => verifyDistributionManifest({
      manifest: { ...createDistributionManifest(fixture.payload), manifestDigest: '0'.repeat(64) },
      trustedOwnershipList: fixture.trusted, sourceRoot: fixture.root, expectedSourceRepository: REPOSITORY,
    }), /manifestDigest/);
  });
});

test('trusted inventory requires exact tuples including optional entries', () => {
  withFixture(fixture => {
    const first = fixture.payload.entries[0]!;
    const optional = fixture.payload.entries[1]!;
    for (const entries of [
      [first], [optional], [],
      [first, { ...optional, targetPath: 'elsewhere.txt' }],
      [first, { ...optional, sourcePath: 'elsewhere.txt' }],
      [first, { ...optional, classification: 'required' as const }],
      [first, optional, { ...optional, sourcePath: 'extra.txt', targetPath: 'extra.txt' }],
    ]) assert.throws(() => verify(fixture, { ...fixture.payload, entries }), /inventory/);
    assert.doesNotThrow(() => verify(fixture, fixture.payload, { ...fixture.trusted, entries: [...fixture.trusted.entries].reverse() }));
    assert.throws(() => verify(fixture, fixture.payload, { ...fixture.trusted, entries: [] }), /inventory/);
  });
});

test('source mutations and wrong digests are rejected without writes', () => {
  withFixture(fixture => {
    const wrong = { ...fixture.payload, entries: fixture.payload.entries.map(entry => ({ ...entry, contentDigest: '0'.repeat(64) })) };
    assert.throws(() => verify(fixture, wrong), /contentDigest/);
    writeFileSync(join(fixture.root, 'assets', 'bytes.bin'), Buffer.from([0, 255, 254, 10, 128, 0]));
    const before = snapshot(fixture.root);
    assert.throws(() => verify(fixture), /source bytes/);
    // Re-signing the dirty bytes cannot bypass the committed-blob comparison.
    const updated = { ...fixture.payload, entries: fixture.payload.entries.map(entry => ({ ...entry, contentDigest: sha256Bytes(readFileSync(join(fixture.root, entry.sourcePath))) })) };
    assert.throws(() => verify(fixture, updated), /source bytes/);
    assert.deepEqual(snapshot(fixture.root), before);
  });
});

test('untracked source files, missing files, directories, and nested roots fail closed', () => {
  withFixture(fixture => {
    writeFileSync(join(fixture.root, 'untracked.txt'), Buffer.alloc(0));
    const trusted: TrustedOwnershipList = { ...fixture.trusted, entries: [{ sourcePath: 'untracked.txt', targetPath: 'untracked.txt', classification: 'required' }] };
    const payload: DistributionManifestPayload = { ...fixture.payload, entries: [{ ...trusted.entries[0]!, ownership: 'framework', contentDigest: EMPTY_DIGEST }] };
    assert.throws(() => verify(fixture, payload, trusted), /commit-tree blob/);
    assert.throws(() => verifyDistributionManifest({
      manifest: createDistributionManifest(fixture.payload), trustedOwnershipList: fixture.trusted,
      sourceRoot: join(fixture.root, 'assets'), expectedSourceRepository: REPOSITORY,
    }), /worktree root/);
    rmSync(join(fixture.root, 'empty.txt'));
    assert.throws(() => verify(fixture), /rejected input/);
    mkdirSync(join(fixture.root, 'empty.txt'));
    assert.throws(() => verify(fixture), /regular file/);
  });
});

test('worktree symlinks, ancestor symlinks, and committed symlink blobs are rejected', { skip: process.platform === 'win32' }, () => {
  withFixture(fixture => {
    rmSync(join(fixture.root, 'empty.txt'));
    symlinkSync('assets/bytes.bin', join(fixture.root, 'empty.txt'));
    assert.throws(() => verify(fixture), /regular file/);
    fixtureGit(fixture.root, ['add', '--', 'empty.txt']);
    fixtureGit(fixture.root, ['commit', '-m', 'symlink fixture']);
    const payload = { ...fixture.payload, sourceSha: fixtureGit(fixture.root, ['rev-parse', 'HEAD']) };
    assert.throws(() => verify(fixture, payload), /commit-tree blob/);
  });
  withFixture(fixture => {
    rmSync(join(fixture.root, 'assets'), { recursive: true });
    mkdirSync(join(fixture.root, 'replacement'));
    writeFileSync(join(fixture.root, 'replacement', 'bytes.bin'), Buffer.from([0, 255, 254, 13, 10, 128, 0]));
    symlinkSync('replacement', join(fixture.root, 'assets'));
    assert.throws(() => verify(fixture), /plain directory/);
  });
});
