import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectInvocationFragments } from '../src/ai-usage-log-boundaries.js';
import { parseInvocationEvidence } from '../src/ai-usage-evidence.js';

const header = ['OpenAI Codex v1.0', '--------', '\x1b[1mmodel:\x1b[0m observed-model', '--------', '\x1b[36muser\x1b[0m', 'model: prompt-model'];
function timestamp(lines: string[]): string {
  return lines.map(line => `2026-09-25T10:00:00.1234567Z ${line}`).join('\r\n');
}
function parse(log: string) {
  return selectInvocationFragments(log).map(fragment => parseInvocationEvidence({
    owner: 'owner', repo: 'repo', runId: '1', jobId: '2', stage: 'PLAN', ...fragment,
  }));
}

test('observed ANSI/timestamp format pairs summaries delayed by 1, 2, 3 and 108 lines', () => {
  for (const delay of [1, 2, 3, 108]) {
    const raw = timestamp([
      ...header, '\x1b[2mtokens used\x1b[0m',
      ...Array.from({ length: delay - 1 }, () => '{"output":"interleaved"}'), '42,356',
    ]);
    const fragments = selectInvocationFragments(raw);
    assert.equal(fragments[0]?.bannerLog, 'model: observed-model');
    assert.equal(fragments[0]?.completionLog, 'tokens used\n42,356');
    const result = parse(raw)[0]!;
    assert.equal(result.model, 'observed-model');
    assert.equal(result.tokenUsage, 42356);
    assert.equal(result.providerCallCount, 1);
    assert.equal(result.monetaryCost, null);
  }
});

test('preserves indentation and selects only the first exact unindented integer', () => {
  const result = parse(timestamp([...header, 'tokens used', ' 999', '\t888', '12,34', '1.5', '0', '123']))[0]!;
  assert.equal(result.tokenUsage, 0);
  assert.equal(parse(timestamp([...header, 'tokens used', ' 999']))[0]?.tokenUsage, null);
});

test('ordinals and token searches stop at the next banner', () => {
  const result = parse(timestamp([...header, 'tokens used', ...header, 'tokens used', '25']));
  assert.deepEqual(result.map(value => value.ordinal), [1, 2]);
  assert.deepEqual(result.map(value => value.tokenUsage), [null, 25]);
  assert.match(result[1]!.sourceRef, /#codex-2$/);
  assert.deepEqual(selectInvocationFragments('ordinary job output'), []);
});

test('missing, repeated, malformed and unsafe measurements remain null', () => {
  for (const completion of [[], ['tokens used'], ['tokens used: 12', '12'], ['tokens used', '12', 'tokens used', '12'], ['tokens used', '9007199254740992']]) {
    const result = parse(timestamp([...header, ...completion]))[0]!;
    assert.equal(result.tokenUsage, null);
    assert.equal(result.providerCallCount, null);
  }
  const duplicate = parse(timestamp(['OpenAI Codex v1', '--------', 'model: a', 'model: b', '--------', 'tokens used', '12']))[0]!;
  assert.equal(duplicate.model, null);
  assert.equal(duplicate.tokenUsage, 12);
});

test('does not harvest prompt model text from a missing header or confirm malformed starts', () => {
  const missing = parse(timestamp(['OpenAI Codex v1', '--------', 'user', 'model: prompt', '--------', 'tokens used', '12']))[0]!;
  assert.equal(missing.model, null);
  assert.equal(missing.tokenUsage, null);
  assert.throws(() => selectInvocationFragments('OpenAI Codex v1\nuser\nmodel: prompt'), /Unconfirmed/);
});
