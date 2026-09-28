---
id: contract-state-diff
version: 1
description: Compare explicitly selected EVM contract fields at two pinned blocks, or against a saved snapshot, and report changes separately from unreadable fields.
role: implement
kind: code
judge: verifier-paths
checks: none
requires:
  - network
reads:
  - skill:contract-state-diff
variables:
  - objective
writes:
  - artifacts/contract-state-diff/config.json
  - artifacts/contract-state-diff/snapshot.json
  - artifacts/contract-state-diff/changes.json
  - artifacts/contract-state-diff/report.md
mustProduce:
  - artifacts/contract-state-diff/config.json
  - artifacts/contract-state-diff/snapshot.json
  - artifacts/contract-state-diff/changes.json
  - artifacts/contract-state-diff/report.md
objective: "{{objective}}"
acceptanceCriteria:
  - artifacts/contract-state-diff/config.json contains the requested chain and explicit calls, with no inferred targets, callers or return types
  - snapshot.json records each block number and hash, normalized configuration, raw successful responses and a status for every requested field
  - changes.json distinguishes changed, unchanged, unknown and baseline-only fields; an unreadable value is never reported as unchanged
  - node .imd/reads/skills/contract-state-diff/scripts/check-output.mjs artifacts/contract-state-diff succeeds
  - report.md names the observed interval, coverage, failed fields and limitations; it does not claim independent verification, finality or a complete history of changes
---

Produce one bounded observation report, not a contract audit. The verifier checks delivered paths
and bytes (class 2); it does not rerun RPC reads or certify their truth.

1. **Start with the requested inputs.** Open the pinned
   `.imd/reads/skills/contract-state-diff/REFERENCE.md` for the configuration and CLI contract.
   Write `artifacts/contract-state-diff/config.json` from the supplied chain, addresses, encoded
   calls, callers and return types. Use at most three contracts and 24 fields. If the brief gives
   only an ABI, obtain explicit encoded calls from the supplied project tooling; do not guess
   selectors or field semantics. If essential inputs are absent, report the missing inputs.
2. **Use the pinned collector.** Run `scripts/state-diff.mjs` under that same pinned skill directory,
   with two requested blocks, a prior snapshot and a closing block, or an explicitly requested
   baseline-only run. Set `IMD_RPC_URL` to the authorized endpoint in the process environment.
   The reference gives commands. Do not put credentials in artifacts or command arguments.
3. **Check the bundle.** Run the pinned `scripts/check-output.mjs` on the output directory. The
   collector's exit 2 means an honest partial report with unknown fields, not permission to fill
   gaps. Explain those failures in the final response. Exit 1 means no valid new bundle: do not
   submit old artifacts as this run's result.

**Keep the observation fixed.** Do not change the requested configuration or widen the interval
to get a successful result. All state calls use canonical block hashes; a provider without this
support cannot silently fall back to number-based reads. Baseline mode rechecks the saved block
hash and configuration, but does not authenticate saved values.

**Describe only what was observed.** Changes are not automatically exploits, and unchanged fields
are not a safety verdict. Snapshot comparison misses temporary changes that were later reversed.
Do not invent severity or automatically discover every administrative capability.

**Finish in this run.** Run in the foreground within the fixed budget. Do not schedule monitoring
or send notifications. On failure, name the failed stage or field and the sanitized error code;
never expose endpoint credentials or promise a background continuation.
