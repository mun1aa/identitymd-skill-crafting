import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const collector = fileURLToPath(new URL('../scripts/state-diff.mjs', import.meta.url));
const checker = fileURLToPath(new URL('../scripts/check-output.mjs', import.meta.url));
const output = 'artifacts/contract-state-diff';
const config = { v: 1, chainId: '1', calls: [
  { id: 'owner', to: `0x${'11'.repeat(20)}`, data: '0x8da5cb5b', returns: 'address' },
] };

// Intercept only the test child process's HTTP boundary; exercise the real CLI, transport,
// collection, serialization, fixed output paths, exit codes and independent checker process.
const mockModule = `
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  let result;
  if (request.method === 'eth_chainId') result = process.env.DEMO_MODE === 'wrong-chain' ? '0x2' : '0x1';
  if (request.method === 'eth_getBlockByNumber') {
    result = { number: request.params[0], hash: '0x' + (request.params[0] === '0xa' ? 'aa' : 'bb').repeat(32) };
  }
  if (request.method === 'eth_getCode') result = '0x6000';
  if (request.method === 'eth_call') {
    if (process.env.DEMO_MODE === 'partial') return new Response(JSON.stringify({
      jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'SECRET_PROVIDER_MESSAGE' }
    }));
    result = '0x' + '0'.repeat(24) + (request.params[1].blockHash.includes('aaaa') ? '22' : '33').repeat(20);
  }
  if (result === undefined) throw new Error('unexpected RPC method');
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
};
`;

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'contract-diff-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mock = join(directory, 'mock-fetch.mjs');
  await writeFile(mock, mockModule);
  await writeFile(join(directory, 'input.json'), JSON.stringify(config));
  const run = (args, mode = 'complete') => spawnSync(process.execPath, ['--import', mock, collector, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, IMD_RPC_URL: 'https://example.invalid/SECRET_API_KEY', DEMO_MODE: mode },
  });
  const check = () => spawnSync(process.execPath, [checker, output], { cwd: directory, encoding: 'utf8' });
  return { directory, run, check };
}
const args = ['--config', 'input.json', '--from-block', '10', '--to-block', '11'];

test('CLI creates a checkable changed report without writing RPC credentials', async t => {
  const { directory, run, check } = await setup(t);
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check().status, 0);
  for (const file of ['config.json', 'snapshot.json', 'changes.json', 'report.md']) {
    const text = await readFile(join(directory, output, file), 'utf8');
    assert.ok(!text.includes('SECRET_'));
  }
  const changes = JSON.parse(await readFile(join(directory, output, 'changes.json'), 'utf8'));
  assert.equal(changes.counts.changed, 1);
});

test('CLI partial evidence exits 2 but passes structural checking', async t => {
  const { directory, run, check } = await setup(t);
  const result = run(args, 'partial');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(check().status, 0);
  const text = await readFile(join(directory, output, 'snapshot.json'), 'utf8');
  assert.ok(!text.includes('SECRET_'));
  assert.match(text, /rpc_error/);
});

test('CLI rejects wrong chain without producing a new successful bundle', async t => {
  const { run, check } = await setup(t);
  const result = run(args, 'wrong-chain');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /chain/);
  assert.equal(check().status, 1);
});

test('CLI reuses its prior closing snapshot before overwriting fixed outputs', async t => {
  const { directory, run, check } = await setup(t);
  assert.equal(run(['--config', 'input.json', '--to-block', '10']).status, 0);
  assert.equal(run(['--config', 'input.json', '--baseline', `${output}/snapshot.json`, '--to-block', '11']).status, 0);
  assert.equal(check().status, 0);
  const changes = JSON.parse(await readFile(join(directory, output, 'changes.json'), 'utf8'));
  assert.equal(changes.counts.changed, 1);
  assert.equal(changes.fromBlock.number, '10');
});

test('CLI rejects unexpected, duplicate, and incomplete options', async t => {
  const { run } = await setup(t);
  for (const extra of [['--out', '../outside'], ['--to-block', '12'], ['--baseline']]) {
    const result = run([...args, ...extra]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI option/);
  }
});
