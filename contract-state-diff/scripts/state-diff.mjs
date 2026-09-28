#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO = `0x${'0'.repeat(40)}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = HASH;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const ERROR_CODES = new Set([
  'rpc_error', 'rpc_transport', 'rpc_timeout', 'rpc_http', 'rpc_response',
  'rpc_too_large', 'no_code', 'invalid_code', 'invalid_return',
]);
export const OUTPUT_DIR = 'artifacts/contract-state-diff';

function ensure(ok, message) {
  if (!ok) throw new Error(message);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, allowed, message) {
  ensure(object(value) && Object.keys(value).every(k => allowed.includes(k)), message);
}
function decimal(value, message) {
  ensure(typeof value === 'string' && DECIMAL.test(value) && value.length <= 78, message);
  return value;
}
function returnType(value) {
  if (['address', 'bool', 'bytes32'].includes(value)) return value;
  const m = /^(u?int)([0-9]+)$/.exec(value);
  ensure(m && +m[2] >= 8 && +m[2] <= 256 && +m[2] % 8 === 0 && `${+m[2]}` === m[2],
    'unsupported return type');
  return value;
}
export function normalizeConfig(input) {
  keys(input, ['v', 'chainId', 'calls'], 'invalid configuration fields');
  ensure(input.v === 1, 'unsupported configuration version');
  const chainId = decimal(input.chainId, 'chainId must be a decimal string');
  ensure(BigInt(chainId) > 0n, 'chainId must be positive');
  ensure(Array.isArray(input.calls) && input.calls.length > 0 && input.calls.length <= 24,
    'supply 1 to 24 calls');
  const calls = input.calls.map(c => {
    keys(c, ['id', 'to', 'data', 'returns', 'from'], 'invalid call fields');
    ensure(typeof c.id === 'string' && ID.test(c.id), 'invalid field id');
    ensure(typeof c.to === 'string' && ADDRESS.test(c.to), 'invalid target address');
    ensure(typeof c.data === 'string' && /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(c.data)
      && c.data.length <= 8194, 'invalid encoded call');
    ensure(c.from === undefined || (typeof c.from === 'string' && ADDRESS.test(c.from)),
      'invalid caller address');
    ensure(typeof c.returns === 'string', 'missing return type');
    return { id: c.id, to: c.to.toLowerCase(), data: c.data.toLowerCase(),
      returns: returnType(c.returns), from: (c.from ?? ZERO).toLowerCase() };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  ensure(new Set(calls.map(c => c.id)).size === calls.length, 'duplicate field id');
  ensure(new Set(calls.map(c => c.to)).size <= 3, 'at most three target contracts');
  return { v: 1, chainId, calls };
}
export function configHash(config) {
  return createHash('sha256').update(JSON.stringify(normalizeConfig(config))).digest('hex');
}
export function decodeWord(raw, type) {
  ensure(typeof raw === 'string' && WORD.test(raw), 'invalid_return');
  returnType(type);
  const word = raw.toLowerCase();
  const n = BigInt(word);
  if (type === 'bytes32') return word;
  if (type === 'address') {
    ensure(n < (1n << 160n), 'invalid_return');
    return `0x${word.slice(-40)}`;
  }
  if (type === 'bool') {
    ensure(n === 0n || n === 1n, 'invalid_return');
    return n === 1n;
  }
  const bits = BigInt(type.match(/[0-9]+$/)[0]);
  if (type.startsWith('uint')) {
    ensure(n < (1n << bits), 'invalid_return');
    return n.toString();
  }
  const signed = BigInt.asIntN(256, n);
  ensure(signed >= -(1n << (bits - 1n)) && signed < (1n << (bits - 1n)), 'invalid_return');
  return signed.toString();
}

export class RpcFailure extends Error {
  constructor(code, rpcCode) {
    super(code);
    this.code = code;
    if (Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode;
  }
}
function failure(error) {
  // Provider messages may contain URLs, credentials, or arbitrary text. Keep only safe codes.
  if (!(error instanceof RpcFailure)) throw error;
  const result = { code: error.code };
  if (error.rpcCode !== undefined) result.rpcCode = error.rpcCode;
  return result;
}
export function createRpc(endpoint, { timeoutMs = 10000, maxBytes = 1048576, fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('invalid IMD_RPC_URL'); }
  ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    'IMD_RPC_URL must be HTTP(S), without userinfo or a fragment');
  let seq = 0;
  return async (method, params) => {
    const id = ++seq;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (!response.ok) throw new RpcFailure('rpc_http');
      const reader = response.body?.getReader();
      if (!reader) throw new RpcFailure('rpc_response');
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) throw new RpcFailure('rpc_too_large');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RpcFailure('rpc_response'); }
      if (!object(body) || body.jsonrpc !== '2.0' || body.id !== id ||
          Object.hasOwn(body, 'error') === Object.hasOwn(body, 'result')) {
        throw new RpcFailure('rpc_response');
      }
      if (Object.hasOwn(body, 'error')) throw new RpcFailure('rpc_error', body.error?.code);
      return body.result;
    } catch (e) {
      if (e instanceof RpcFailure) throw e;
      throw new RpcFailure(controller.signal.aborted ? 'rpc_timeout' : 'rpc_transport');
    } finally { clearTimeout(timer); }
  };
}

function blockSelector(value) {
  ensure(typeof value === 'string', 'block selector must be a string');
  if (['safe', 'finalized'].includes(value)) return value;
  if (DECIMAL.test(value) && value.length <= 78) return `0x${BigInt(value).toString(16)}`;
  if (QUANTITY.test(value) && value.length <= 66) return value.toLowerCase();
  throw new Error('use an explicit block number, safe or finalized');
}
function header(result, requested) {
  ensure(object(result) && typeof result.number === 'string' && QUANTITY.test(result.number)
    && result.number.length <= 66 && typeof result.hash === 'string' && HASH.test(result.hash),
  'missing or invalid block header');
  const number = BigInt(result.number).toString();
  if (QUANTITY.test(requested)) ensure(number === BigInt(requested).toString(), 'wrong block returned');
  return { number, hash: result.hash.toLowerCase() };
}
async function resolveBlock(rpc, selector) {
  const requested = blockSelector(selector);
  return header(await rpc('eth_getBlockByNumber', [requested, false]), requested);
}
async function confirmBlock(rpc, block) {
  const current = await resolveBlock(rpc, block.number);
  ensure(current.hash === block.hash, 'block hash changed; discard this run');
}
async function checkChain(rpc, expected) {
  const result = await rpc('eth_chainId', []);
  ensure(typeof result === 'string' && QUANTITY.test(result) && result.length <= 66
    && BigInt(result).toString() === expected, 'RPC chain does not match configuration');
}
async function readSnapshot(rpc, config, block) {
  const pin = { blockHash: block.hash, requireCanonical: true };
  const codes = new Map();
  const fields = [];
  for (const call of config.calls) {
    if (!codes.has(call.to)) {
      try {
        const code = await rpc('eth_getCode', [call.to, pin]);
        if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code))
          throw new RpcFailure('invalid_code');
        if (code === '0x') throw new RpcFailure('no_code');
        codes.set(call.to, null);
      } catch (e) { codes.set(call.to, failure(e)); }
    }
    const codeError = codes.get(call.to);
    if (codeError) {
      fields.push({ id: call.id, status: 'unknown', error: codeError });
      continue;
    }
    try {
      const raw = await rpc('eth_call', [{ to: call.to, from: call.from, data: call.data }, pin]);
      let value;
      try { value = decodeWord(raw, call.returns); }
      catch { throw new RpcFailure('invalid_return'); }
      fields.push({ id: call.id, status: 'ok', raw: raw.toLowerCase(), value });
    } catch (e) { fields.push({ id: call.id, status: 'unknown', error: failure(e) }); }
  }
  return { block, fields };
}
function validateSample(sample, config) {
  keys(sample, ['block', 'fields'], 'invalid snapshot sample');
  keys(sample.block, ['number', 'hash'], 'invalid snapshot block');
  decimal(sample.block.number, 'invalid snapshot block number');
  ensure(typeof sample.block.hash === 'string' && /^0x[0-9a-f]{64}$/.test(sample.block.hash),
    'invalid snapshot block hash');
  ensure(Array.isArray(sample.fields) && sample.fields.length === config.calls.length,
    'snapshot field coverage differs');
  sample.fields.forEach((field, i) => {
    ensure(object(field) && field.id === config.calls[i].id, 'snapshot field identity differs');
    if (field.status === 'ok') {
      keys(field, ['id', 'status', 'raw', 'value'], 'invalid successful field');
      ensure(typeof field.raw === 'string' && field.raw === field.raw.toLowerCase(), 'invalid raw value');
      ensure(field.value === decodeWord(field.raw, config.calls[i].returns), 'raw and decoded values differ');
    } else {
      keys(field, ['id', 'status', 'error'], 'invalid unknown field');
      ensure(field.status === 'unknown', 'invalid field status');
      keys(field.error, ['code', 'rpcCode'], 'invalid field error');
      ensure(ERROR_CODES.has(field.error.code), 'invalid field error code');
      ensure(field.error.rpcCode === undefined || Number.isSafeInteger(field.error.rpcCode),
        'invalid RPC error code');
    }
  });
}
export function validateSnapshot(snapshot) {
  keys(snapshot, ['v', 'config', 'configHash', 'sourceLabel', 'fromSource', 'from', 'to'],
    'invalid snapshot fields');
  ensure(snapshot.v === 1, 'unsupported snapshot version');
  const config = normalizeConfig(snapshot.config);
  ensure(JSON.stringify(config) === JSON.stringify(snapshot.config), 'snapshot config is not normalized');
  ensure(configHash(config) === snapshot.configHash, 'snapshot config hash differs');
  ensure(typeof snapshot.sourceLabel === 'string' && ID.test(snapshot.sourceLabel), 'invalid source label');
  ensure(['rpc', 'saved-snapshot', 'none'].includes(snapshot.fromSource), 'invalid from source');
  if (snapshot.from === null) ensure(snapshot.fromSource === 'none', 'missing baseline');
  else {
    ensure(snapshot.fromSource !== 'none', 'invalid baseline source');
    validateSample(snapshot.from, config);
  }
  validateSample(snapshot.to, config);
  if (snapshot.from) {
    ensure(BigInt(snapshot.from.block.number) <= BigInt(snapshot.to.block.number), 'reversed block interval');
    if (snapshot.from.block.number === snapshot.to.block.number) {
      ensure(snapshot.from.block.hash === snapshot.to.block.hash, 'same height has different hashes');
      snapshot.from.fields.forEach((f, i) => {
        const end = snapshot.to.fields[i];
        ensure(f.status !== 'ok' || end.status !== 'ok' || f.raw === end.raw,
          'conflicting values at the same block hash');
      });
    }
  }
  return snapshot;
}
export function compareSnapshots(snapshot) {
  validateSnapshot(snapshot);
  const fields = snapshot.to.fields.map((to, i) => {
    const from = snapshot.from?.fields[i] ?? null;
    let status;
    if (to.status !== 'ok' || (from && from.status !== 'ok')) status = 'unknown';
    else if (!from) status = 'baseline-only';
    else status = from.value === to.value ? 'unchanged' : 'changed';
    return { id: to.id, status, before: from, after: to };
  });
  const counts = { changed: 0, unchanged: 0, unknown: 0, 'baseline-only': 0 };
  for (const field of fields) counts[field.status]++;
  return { v: 1, configHash: snapshot.configHash, chainId: snapshot.config.chainId,
    fromBlock: snapshot.from?.block ?? null, toBlock: snapshot.to.block,
    mode: snapshot.from ? 'compare' : 'baseline',
    status: counts.unknown ? 'partial' : 'complete', counts, fields };
}
export function renderReport(snapshot, changes = compareSnapshots(snapshot)) {
  const display = field => !field ? 'not sampled' : field.status === 'ok'
    ? String(field.value) : `unknown (${field.error.code}${field.error.rpcCode === undefined ? '' : `: ${field.error.rpcCode}`})`;
  const lines = [
    '# Contract state diff', '', `Chain: ${snapshot.config.chainId}. Source label: ${snapshot.sourceLabel}.`,
    `Configuration SHA-256: ${snapshot.configHash}.`, '',
    `From: ${snapshot.from ? `${snapshot.from.block.number} (${snapshot.from.block.hash})` : 'none; baseline initialization'}.`,
    `To: ${snapshot.to.block.number} (${snapshot.to.block.hash}).`,
    `Earlier values: ${snapshot.fromSource}.`, '',
    `Coverage: ${changes.status}; ${changes.counts.changed} changed, ${changes.counts.unchanged} unchanged, ${changes.counts.unknown} unknown, ${changes.counts['baseline-only']} baseline-only.`, '',
    '| Field | Status | Before | After |', '| --- | --- | --- | --- |',
    ...changes.fields.map(f => `| ${f.id} | ${f.status} | ${display(f.before)} | ${display(f.after)} |`), '',
    '## Interpretation', '',
    '- Only the configured calls were observed. No complete privilege inventory or event history was collected.',
    '- Two snapshots miss temporary changes later reversed. Unchanged fields are not a safety verdict.',
    '- Unknown means a read failed or could not be decoded; it never means zero, false, or unchanged.',
    '- Baseline-only establishes values without asserting a change or lack of change.',
    '- Hash-pinned reads and header rechecks detect some source inconsistencies; they do not prove provider honesty or chain finality.',
    '- Saved baseline values are supplied evidence, not authenticated history. Their block and configuration are rechecked.',
    '- Class 2 artifact validation does not independently rerun RPC observations or authorize money movement or launch.', '',
    'Reproduce with config.json and the recorded block numbers using an authorized IMD_RPC_URL.',
    'Check that the reproduced block hashes match. Endpoint URLs and provider messages are omitted to avoid leaking credentials.', '',
  ];
  return lines.join('\n');
}

export async function collect({ config: input, rpc, fromBlock, toBlock, baseline, sourceLabel = 'rpc-1' }) {
  const config = normalizeConfig(input);
  ensure(typeof sourceLabel === 'string' && ID.test(sourceLabel), 'invalid source label');
  ensure(toBlock !== undefined, 'closing block is required');
  ensure(!(baseline !== undefined && fromBlock !== undefined), 'choose from-block or baseline, not both');
  let from = null;
  if (baseline !== undefined) {
    validateSnapshot(baseline);
    ensure(baseline.configHash === configHash(config), 'baseline configuration differs');
    from = baseline.to;
  }
  await checkChain(rpc, config.chainId);
  if (from) await confirmBlock(rpc, from.block);
  const start = fromBlock === undefined ? null : await resolveBlock(rpc, fromBlock);
  const end = await resolveBlock(rpc, toBlock);
  const first = from?.block ?? start;
  ensure(!first || BigInt(first.number) <= BigInt(end.number), 'reversed block interval');
  if (start) from = await readSnapshot(rpc, config, start);
  const to = await readSnapshot(rpc, config, end);
  if (from) await confirmBlock(rpc, from.block);
  await confirmBlock(rpc, to.block);
  await checkChain(rpc, config.chainId);
  const snapshot = { v: 1, config, configHash: configHash(config), sourceLabel,
    fromSource: baseline !== undefined ? 'saved-snapshot' : start ? 'rpc' : 'none', from, to };
  const changes = compareSnapshots(snapshot);
  return { snapshot, changes, report: renderReport(snapshot, changes) };
}
export async function readJson(path) {
  const bytes = await readFile(path);
  ensure(bytes.byteLength <= 1048576, 'input exceeds 1 MiB');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('input is not valid JSON'); }
}
export async function writeBundle(directory, bundle) {
  await mkdir(directory, { recursive: true });
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(directory, 'config.json'), json(bundle.snapshot.config));
  await writeFile(join(directory, 'snapshot.json'), json(bundle.snapshot));
  await writeFile(join(directory, 'changes.json'), json(bundle.changes));
  await writeFile(join(directory, 'report.md'), bundle.report);
}
function argumentsFor(argv) {
  const allowed = new Set(['--config', '--from-block', '--to-block', '--baseline', '--source-label']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    ensure(allowed.has(argv[i]) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
      && !Object.hasOwn(args, argv[i]), 'invalid, duplicate or missing CLI option');
    args[argv[i]] = argv[i + 1];
  }
  ensure(args['--config'] && args['--to-block'], '--config and --to-block are required');
  return args;
}
async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const config = await readJson(args['--config']);
  const baseline = args['--baseline'] ? await readJson(args['--baseline']) : undefined;
  const bundle = await collect({ config, baseline,
    rpc: createRpc(process.env.IMD_RPC_URL), fromBlock: args['--from-block'],
    toBlock: args['--to-block'], sourceLabel: args['--source-label'] ?? 'rpc-1' });
  await writeBundle(OUTPUT_DIR, bundle);
  console.log(`${bundle.changes.status}: ${JSON.stringify(bundle.changes.counts)}; ${OUTPUT_DIR}`);
  process.exitCode = bundle.changes.status === 'partial' ? 2 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Filesystem errors may include a private path; unexpected exceptions are not reflected.
    const message = error instanceof RpcFailure ? `${error.code}${error.rpcCode === undefined ? '' : ` (${error.rpcCode})`}`
      : error.code ? 'input/output operation failed' : error.message;
    console.error(`contract-state-diff failed: ${message}`);
    process.exitCode = 1;
  });
}
