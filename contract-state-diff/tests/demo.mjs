// Synthetic example generator for maintainers; not delivered to IMD workers.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collect, RpcFailure } from '../scripts/state-diff.mjs';

const config = { v: 1, chainId: '1', calls: [
  { id: 'owner', to: `0x${'11'.repeat(20)}`, data: '0x8da5cb5b', returns: 'address' },
] };
const directory = fileURLToPath(new URL('../examples/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const partial of [false, true]) {
  const rpc = async (method, params) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber') return {
      number: params[0], hash: `0x${(params[0] === '0xa' ? 'aa' : 'bb').repeat(32)}`,
    };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      if (partial && params[1].blockHash.includes('bbbb')) throw new RpcFailure('rpc_error', -32000);
      return `0x${'0'.repeat(24)}${(params[1].blockHash.includes('aaaa') ? '22' : '33').repeat(20)}`;
    }
    throw new Error('unexpected fixture RPC call');
  };
  const bundle = await collect({ config, rpc, fromBlock: '10', toBlock: '11', sourceLabel: 'synthetic-fixture' });
  await writeFile(`${directory}/${partial ? 'partial' : 'changed'}-report.md`, bundle.report);
}
console.log('Generated two synthetic reports; no live RPC requests made.');
