#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, normalizeConfig, compareSnapshots, renderReport } from './state-diff.mjs';

export async function checkOutput(directory) {
  const config = await readJson(join(directory, 'config.json'));
  const snapshot = await readJson(join(directory, 'snapshot.json'));
  const changes = await readJson(join(directory, 'changes.json'));
  const report = await readFile(join(directory, 'report.md'), 'utf8');
  if (!isDeepStrictEqual(config, normalizeConfig(config)) || !isDeepStrictEqual(config, snapshot.config))
    throw new Error('configuration artifacts differ');
  const expected = compareSnapshots(snapshot);
  if (!isDeepStrictEqual(changes, expected)) throw new Error('changes do not match snapshot evidence');
  if (report !== renderReport(snapshot, expected)) throw new Error('report does not match snapshot evidence');
  return expected;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('usage: node check-output.mjs artifacts/contract-state-diff');
    process.exitCode = 1;
  } else {
    checkOutput(process.argv[2]).then(result => {
      console.log(`ok: internally consistent ${result.status} report; RPC observations were not reverified`);
    }).catch(error => {
      console.error(`invalid bundle: ${error.code ? 'missing or unreadable artifact' : error.message}`);
      process.exitCode = 1;
    });
  }
}
