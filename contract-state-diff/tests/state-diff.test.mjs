import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, normalizeConfig, configHash, decodeWord, compareSnapshots, validateSnapshot,
  createRpc, RpcFailure, writeBundle } from '../scripts/state-diff.mjs';
import { checkOutput } from '../scripts/check-output.mjs';

const ADDRESS = `0x${'11'.repeat(20)}`;
const OWNER_A = `0x${'22'.repeat(20)}`;
const OWNER_B = `0x${'33'.repeat(20)}`;
const HASH_A = `0x${'aa'.repeat(32)}`;
const HASH_B = `0x${'bb'.repeat(32)}`;
const HASH_C = `0x${'cc'.repeat(32)}`;
const MAX = (1n << 256n) - 1n;
const word = value => `0x${BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0')}`;
const config = {
  v: 1, chainId: '1', calls: [
    { id: 'owner', to: ADDRESS, data: '0x8da5cb5b', returns: 'address' },
    { id: 'fee', to: ADDRESS, data: '0xddca3f43', returns: 'uint256' },
    { id: 'paused', to: ADDRESS, data: '0x5c975abb', returns: 'bool' },
  ],
};
const clone = value => structuredClone(value);

function provider({ override, chain = '0x1' } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    const custom = override?.(method, params, calls);
    if (custom !== undefined) return custom;
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') {
      const n = ['safe', 'finalized'].includes(params[0]) ? '0xb' : params[0];
      return { number: n, hash: n === '0xa' ? HASH_A : HASH_B };
    }
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const [call, pin] = params;
      assert.equal(pin.requireCanonical, true);
      assert.ok([HASH_A, HASH_B].includes(pin.blockHash));
      assert.match(call.from, /^0x[0-9a-f]{40}$/);
      if (call.data === '0x8da5cb5b') return word(pin.blockHash === HASH_A ? OWNER_A : OWNER_B);
      if (call.data === '0xddca3f43') return word(MAX);
      if (call.data === '0x5c975abb') return word(0);
    }
    throw new Error('unexpected test RPC call');
  };
  return { rpc, calls };
}
const run = (options = {}) => collect({ config, ...provider(), fromBlock: '10', toBlock: '11', ...options });

test('detects an owner change and preserves uint256 precision and false values', async () => {
  const { snapshot, changes } = await run();
  assert.equal(changes.status, 'complete');
  assert.deepEqual(changes.counts, { changed: 1, unchanged: 2, unknown: 0, 'baseline-only': 0 });
  const owner = changes.fields.find(f => f.id === 'owner');
  assert.equal(owner.before.value, OWNER_A);
  assert.equal(owner.after.value, OWNER_B);
  assert.equal(snapshot.to.fields.find(f => f.id === 'fee').value, MAX.toString());
  assert.equal(snapshot.to.fields.find(f => f.id === 'paused').value, false);
});

test('every code and state read uses a canonical hash, never a block number', async () => {
  const p = provider();
  await run(p);
  for (const { method, params } of p.calls.filter(c => ['eth_call', 'eth_getCode'].includes(c.method))) {
    assert.deepEqual(params[1], { blockHash: params[1].blockHash, requireCanonical: true });
    assert.ok([HASH_A, HASH_B].includes(params[1].blockHash), method);
  }
  assert.equal(p.calls.filter(c => c.method === 'eth_getCode').length, 2);
});

test('a failed read is unknown even when its earlier value is zero or false', async () => {
  const p = provider({ override(method, params) {
    if (method === 'eth_call' && params[0].data === '0x5c975abb' && params[1].blockHash === HASH_B)
      throw new RpcFailure('rpc_error', -32000);
  } });
  const { changes, report } = await run(p);
  assert.equal(changes.status, 'partial');
  assert.equal(changes.fields.find(f => f.id === 'paused').status, 'unknown');
  assert.equal(changes.counts.unchanged, 1);
  assert.match(report, /unknown \(rpc_error: -32000\)/);
});

test('failed reads on both sides are not unchanged', async () => {
  const p = provider({ override(method) { if (method === 'eth_call') throw new RpcFailure('rpc_timeout'); } });
  const { changes } = await run(p);
  assert.equal(changes.counts.unknown, 3);
  assert.equal(changes.counts.unchanged, 0);
});

test('EIP-1898 rejection produces unknown fields without number-based fallback', async () => {
  const p = provider({ override(method) {
    if (method === 'eth_getCode') throw new RpcFailure('rpc_error', -32602);
  } });
  const { changes } = await run(p);
  assert.equal(changes.counts.unknown, 3);
  assert.equal(p.calls.filter(c => c.method === 'eth_call').length, 0);
});

test('absence of code does not become a zero value', async () => {
  const p = provider({ override(method) { if (method === 'eth_getCode') return '0x'; } });
  const { changes } = await run(p);
  assert.equal(changes.counts.unknown, 3);
  assert.equal(changes.fields[0].after.error.code, 'no_code');
});

test('malformed or multi-word return data becomes unknown', async () => {
  for (const raw of ['0x', word(2), `${word(0)}${'0'.repeat(64)}`]) {
    const one = { v: 1, chainId: '1', calls: [config.calls[2]] };
    const p = provider({ override(method) { if (method === 'eth_call') return raw; } });
    const { changes } = await run({ config: one, ...p });
    assert.equal(changes.fields[0].status, 'unknown');
    assert.equal(changes.fields[0].after.error.code, 'invalid_return');
  }
});

test('strict ABI decoding checks padding, widths and signed extension', () => {
  assert.equal(decodeWord(word(255), 'uint8'), '255');
  assert.throws(() => decodeWord(word(256), 'uint8'));
  assert.equal(decodeWord(word(-128), 'int8'), '-128');
  assert.equal(decodeWord(word(127), 'int8'), '127');
  assert.throws(() => decodeWord(word(128), 'int8'));
  assert.throws(() => decodeWord(word(255), 'int8'));
  assert.throws(() => decodeWord(word(-129), 'int8'));
  assert.throws(() => decodeWord(word(1n << 160n), 'address'));
  assert.equal(decodeWord(HASH_A, 'bytes32'), HASH_A);
});

test('canonical config hashing ignores call order but includes caller and semantics', () => {
  const reordered = clone(config); reordered.calls.reverse();
  assert.equal(configHash(config), configHash(reordered));
  for (const [key, value] of [['from', OWNER_A], ['to', OWNER_A], ['returns', 'bytes32'], ['data', '0x11223344']]) {
    const changed = clone(config); changed.calls[0][key] = value;
    assert.notEqual(configHash(config), configHash(changed));
  }
});

test('rejects ambiguous, duplicate, oversized and unsupported configurations', () => {
  const cases = [
    { ...config, chainId: 1 }, { ...config, chainId: '01' }, { ...config, chainId: '0' },
    { ...config, rpcUrl: 'https://example.invalid' }, { ...config, calls: [] },
    { ...config, calls: Array(25).fill(config.calls[0]) },
    { ...config, calls: [config.calls[0], config.calls[0]] },
    { ...config, calls: [{ ...config.calls[0], id: 'unsafe|markdown' }] },
    { ...config, calls: [{ ...config.calls[0], data: '0x123' }] },
    { ...config, calls: [{ ...config.calls[0], returns: 'uint' }] },
    { ...config, calls: [{ ...config.calls[0], returns: 'string' }] },
    { ...config, calls: [{ ...config.calls[0], returns: 'uint7' }] },
  ];
  for (const c of cases) assert.throws(() => normalizeConfig(c));
});

test('wrong chain fails before any contract reads', async () => {
  const p = provider({ chain: '0x89' });
  await assert.rejects(run(p), /chain/);
  assert.equal(p.calls.length, 1);
});

test('a provider chain switch during collection invalidates the run', async () => {
  let n = 0;
  const p = provider({ override(method) { if (method === 'eth_chainId') return ++n === 1 ? '0x1' : '0x2'; } });
  await assert.rejects(run(p), /chain/);
});

test('a changed canonical header invalidates the run', async () => {
  let n = 0;
  const p = provider({ override(method, params) {
    if (method === 'eth_getBlockByNumber' && params[0] === '0xa')
      return { number: '0xa', hash: ++n === 1 ? HASH_A : HASH_C };
  } });
  await assert.rejects(run(p), /block hash changed/);
});

test('missing blocks and wrong-height responses invalidate the run', async () => {
  for (const result of [null, { number: '0xc', hash: HASH_A }]) {
    const p = provider({ override(method) { if (method === 'eth_getBlockByNumber') return result; } });
    await assert.rejects(run(p), /block/);
  }
});

test('resolves safe/finalized once and rejects pending/latest or reversed intervals', async () => {
  for (const toBlock of ['safe', 'finalized']) {
    const p = provider();
    const { snapshot } = await run({ ...p, toBlock });
    assert.equal(snapshot.to.block.number, '11');
    assert.equal(p.calls.filter(c => c.params[0] === toBlock).length, 1);
  }
  for (const toBlock of ['pending', 'latest', '9']) await assert.rejects(run({ toBlock }));
});

test('baseline-only run does not assert unchanged', async () => {
  const { changes } = await run({ fromBlock: undefined });
  assert.equal(changes.mode, 'baseline');
  assert.equal(changes.counts['baseline-only'], 3);
  assert.equal(changes.counts.unchanged, 0);
});

test('saved snapshot is reusable and its closing block is rechecked', async () => {
  const first = await run({ fromBlock: undefined, toBlock: '10' });
  const p = provider();
  const { snapshot, changes } = await run({ ...p, fromBlock: undefined, baseline: first.snapshot });
  assert.equal(snapshot.fromSource, 'saved-snapshot');
  assert.deepEqual(changes.counts, { changed: 1, unchanged: 2, unknown: 0, 'baseline-only': 0 });
  assert.ok(p.calls.some(c => c.method === 'eth_getBlockByNumber' && c.params[0] === '0xa'));
  assert.equal(p.calls.filter(c => c.method === 'eth_call').length, 3);
});

test('rejects changed baseline configuration and ambiguous baseline arguments', async () => {
  const { snapshot } = await run({ fromBlock: undefined, toBlock: '10' });
  const altered = clone(config); altered.calls[0].from = OWNER_A;
  await assert.rejects(run({ config: altered, fromBlock: undefined, baseline: snapshot }), /configuration differs/);
  await assert.rejects(run({ baseline: snapshot }), /not both/);
});

test('rejects a baseline whose block is no longer canonical', async () => {
  const { snapshot } = await run({ fromBlock: undefined, toBlock: '10' });
  const p = provider({ override(method, params) {
    if (method === 'eth_getBlockByNumber' && params[0] === '0xa') return { number: '0xa', hash: HASH_C };
  } });
  await assert.rejects(run({ ...p, fromBlock: undefined, baseline: snapshot }), /block hash changed/);
});

test('checks baseline coverage and the link between raw and decoded values', async () => {
  const { snapshot } = await run();
  const missing = clone(snapshot); missing.to.fields.pop();
  assert.throws(() => validateSnapshot(missing), /coverage/);
  const altered = clone(snapshot); altered.to.fields[0].value = '123';
  assert.throws(() => validateSnapshot(altered), /decoded/);
  const hash = clone(snapshot); hash.configHash = 'x';
  assert.throws(() => validateSnapshot(hash), /hash/);
});

test('unknown saved values remain unknown even after a successful new read', async () => {
  const p = provider({ override(method) { if (method === 'eth_call') throw new RpcFailure('rpc_transport'); } });
  const first = await run({ ...p, fromBlock: undefined, toBlock: '10' });
  const { changes } = await run({ fromBlock: undefined, baseline: first.snapshot });
  assert.equal(changes.counts.unknown, 3);
});

test('rejects conflicting values at the same block hash', async () => {
  const { snapshot } = await run({ toBlock: '10' });
  assert.equal(compareSnapshots(snapshot).counts.unchanged, 3);
  const altered = clone(snapshot);
  altered.to.fields[0].raw = word(1);
  altered.to.fields[0].value = '1';
  assert.throws(() => validateSnapshot(altered), /conflicting values/);
});

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'contract-state-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('bundle checker accepts complete and partial evidence and rejects tampered conclusions', async t => {
  const dir = await temp(t);
  const bundle = await run();
  await writeBundle(dir, bundle);
  assert.equal((await checkOutput(dir)).counts.changed, 1);
  const p = provider({ override(method) { if (method === 'eth_call') throw new RpcFailure('rpc_timeout'); } });
  await writeBundle(dir, await run(p));
  assert.equal((await checkOutput(dir)).status, 'partial');
  const changes = JSON.parse(await readFile(join(dir, 'changes.json'), 'utf8'));
  changes.status = 'complete';
  await writeFile(join(dir, 'changes.json'), JSON.stringify(changes));
  await assert.rejects(checkOutput(dir), /changes/);
  await writeBundle(dir, bundle);
  await writeFile(join(dir, 'report.md'), 'No changes, everything is safe.');
  await assert.rejects(checkOutput(dir), /report/);
});

function responseFor(body, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...extra });
}
test('HTTP transport correlates JSON-RPC responses and exposes only safe error codes', async () => {
  const secret = 'private-provider-key';
  const rpc = createRpc(`https://example.invalid/${secret}`, { fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(options.redirect, 'error');
    return responseFor({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: secret } });
  } });
  await assert.rejects(rpc('eth_call', []), error => {
    assert.equal(error.code, 'rpc_error');
    assert.equal(error.rpcCode, -32000);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('HTTP transport rejects mismatched IDs, broken JSON and contradictory envelopes', async () => {
  for (const body of [
    { jsonrpc: '2.0', id: 999, result: '0x1' },
    { jsonrpc: '2.0', id: 1, result: '0x1', error: null },
    { id: 1, result: '0x1' }, 'not json',
  ]) {
    const rpc = createRpc('https://example.invalid', { fetchImpl: async () => responseFor(body) });
    await assert.rejects(rpc('eth_chainId', []), { code: 'rpc_response' });
  }
});

test('HTTP transport bounds response size and sanitizes transport failures', async () => {
  const large = createRpc('https://example.invalid', {
    maxBytes: 8, fetchImpl: async () => responseFor('123456789'),
  });
  await assert.rejects(large('eth_chainId', []), { code: 'rpc_too_large' });
  const broken = createRpc('https://example.invalid', { fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(broken('eth_chainId', []), { message: 'rpc_transport' });
});

test('HTTP transport times out and rejects HTTP errors', async () => {
  const slow = createRpc('https://example.invalid', {
    timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(slow('eth_chainId', []), { code: 'rpc_timeout' });
  const http = createRpc('https://example.invalid', { fetchImpl: async () => responseFor('secret', { status: 403 }) });
  await assert.rejects(http('eth_chainId', []), { code: 'rpc_http' });
});

test('rejects non-HTTP, userinfo and fragment endpoint URLs', () => {
  for (const url of ['file:///tmp/input', 'https://user:secret@example.invalid', 'https://example.invalid/#secret', undefined])
    assert.throws(() => createRpc(url));
});
