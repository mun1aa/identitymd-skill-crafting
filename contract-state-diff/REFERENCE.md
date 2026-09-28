# Contract state diff v1

## Purpose and boundaries

Compare explicit EVM read calls at two hash-pinned blocks, or initialize/reuse a saved baseline.
One chain, at most three target contracts and 24 calls per run. No transactions are signed or
broadcast. This is a class 2 observation artifact, not an attestation or a launch/payment gate.

Unlike a source-code entry-point inventory or a single oracle call-comparison recipe, this package
defines a reusable multi-field snapshot, configuration identity, typed evidence, unknown-state
handling and a deterministic diff. A generic research report can discuss such observations; this
skill fixes their format and collection procedure.

Node 18+ with built-in fetch is required. There are no package dependencies. The bundled files are
`scripts/state-diff.mjs` and `scripts/check-output.mjs`. Read them from the pinned skill directory,
not a live download. Repository tests and demo material are for contributors; they do not travel
with `reads: skill:contract-state-diff`.

## Configuration

Supply `artifacts/contract-state-diff/config.json`:

```json
{
  "v": 1,
  "chainId": "1",
  "calls": [
    {
      "id": "owner",
      "to": "0x1111111111111111111111111111111111111111",
      "data": "0x8da5cb5b",
      "returns": "address",
      "from": "0x0000000000000000000000000000000000000000"
    }
  ]
}
```

The address above is illustrative, not a live target. Obtain targets and encoded calldata from
the request or its supplied project. Do not treat a selector name as proof of a contract's semantics.

- `chainId` is a positive decimal string. Values and block numbers never pass through floating point.
- `id` is a unique 1–64 character identifier using letters, digits, dots, underscores or hyphens;
  the first character must be alphanumeric. It is also the report label.
- `data` is already encoded calldata: a four-byte selector followed by any encoded arguments,
  at most 4096 bytes. ABI parsing and selector calculation are deliberately outside this version.
- `returns` is exactly one ABI word: `address`, `bool`, `bytes32`, or explicit `uintN`/`intN`
  with N a multiple of eight from 8 through 256. Tuples, strings, arrays, `uint` aliases and
  multi-word return values are unsupported. Invalid padding or widths produce unknown results.
- `from` defaults to the zero address. Choose it explicitly when the call depends on the caller.
  The collector uses `eth_call`; it does not establish that the selected function is declared view.
- Unknown configuration keys are rejected. URLs, API keys and arbitrary annotations do not belong
  here. Hashing uses SHA-256 over the normalized configuration with calls sorted by `id`, lower-case
  hex and an explicit caller. Changing the target, calldata, type, caller or chain invalidates a
  saved baseline comparison.

## Running

Provide an authorized HTTP(S) RPC URL through `IMD_RPC_URL` in the process environment. Do not
commit it, put it on the command line, or print it. Query/path API keys can be used but are never
copied to output. Userinfo credentials, URL fragments and redirects are rejected. Supply a harmless
`--source-label` such as `rpc-1` to associate artifacts with an endpoint recorded privately.

Two blocks, from the repository root:

```sh
node .imd/reads/skills/contract-state-diff/scripts/state-diff.mjs \
  --config artifacts/contract-state-diff/config.json \
  --from-block 22000000 --to-block 22000020 --source-label rpc-1
node .imd/reads/skills/contract-state-diff/scripts/check-output.mjs \
  artifacts/contract-state-diff
```

The numbers above are examples, not a request to observe a particular chain interval. Selectors
accept decimal or canonical hex block numbers and `safe`/`finalized`. A tag is resolved once;
all subsequent reads use its resolved hash. `latest` and `pending` are not supported in v1.
The provider's view of safe/finalized is not independently established by this tool.

To initialize a baseline, omit `--from-block` only when baseline initialization was requested.
To reuse a baseline, pass `--baseline path/to/prior/snapshot.json` instead of `--from-block`.
The collector fully reads the baseline before replacing the fixed output files, so that path may
be `artifacts/contract-state-diff/snapshot.json`. It compares the previous closing sample to the
new closing sample and verifies its block is still canonical according to the current endpoint.
Saved values are not authenticated or independently recollected; untrusted baseline inputs can
misstate history even if their structure and hash are consistent.

All outputs are fixed under `artifacts/contract-state-diff/`. No output-directory CLI option widens
the skill's write budget. Calls and output writes stay in the foreground.

## Results and failure handling

| File | Contents |
| --- | --- |
| `config.json` | Normalized input without credentials. |
| `snapshot.json` | Version, configuration/hash, source label, baseline origin, opening/closing block evidence and field results. |
| `changes.json` | Blocks, mode, coverage status/counts and a result for every configured field. |
| `report.md` | Deterministic human-readable rendering of the same evidence and limitations. |

Successful fields have `status: ok`, their raw 32-byte return and decoded value. Integer values
are decimal strings, addresses/bytes are lower-case hex, and booleans are JSON booleans. Unknown
fields have `status: unknown` and a sanitized error code, optionally the numeric JSON-RPC code.
Provider error messages and endpoint URLs are deliberately excluded.

Per-field differences are `changed`, `unchanged`, `unknown`, or `baseline-only`. Either side
being unknown makes the comparison unknown. The overall status is `partial` if any comparison
is unknown, otherwise `complete`. Baseline-only never asserts that no changes occurred.

- Exit **0**: complete collection; it may contain changes, or only a new baseline.
- Exit **2**: partial collection; inspect the unknown fields and still run the bundle checker.
- Exit **1**: invalid inputs, chain mismatch, missing block, changed hash or other fatal failure.
  No valid new bundle is promised. Old or partially written artifacts must not be submitted as
  the new result. Fix only the actual input/provider failure within the job's scope, or report it.

The checker recomputes the diff and report from raw evidence and rejects disagreement, incomplete
field coverage, incompatible configurations and contradictory values at the same hash. It does not
call RPC or establish that the evidence was honestly collected.

RPC calls have a ten-second timeout and a one-MiB response cap. The collector does not silently
switch providers, retry indefinitely, change the interval or downgrade hash pinning. A provider
without historical state or EIP-1898 support can yield unknown fields. An unavailable block header
is fatal because there is no trustworthy block identity to attach to those fields.

## Collection mechanics and limitations

Check the chain before and after collection. Resolve both headers, then use `eth_getCode` and
`eth_call` with `{blockHash, requireCanonical: true}`. Recheck both numbered headers afterwards.
No code, a rejected call or malformed return is unknown. There is no fallback to numeric reads.
Reorganization detection relies on the provider; it is not a cryptographic proof of canonicality.

Only supplied calls are covered. Proxy-slot discovery, logs, transient changes, threshold/severity
policy, scheduling and notifications are outside v1. New provider reads may differ if history was
reorganized; compare block hashes before interpreting a reproduction. Historical reads may need
an archive-capable provider. No result claims contract safety, finality or provider independence.

Protocol references for maintainers: [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898),
[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/).
These explain the implemented interface; workers need no live guidance fetch.

## Contributor validation

From the repository root:

```sh
node check-skill.mjs contract-state-diff
node --test contract-state-diff/tests/*.test.mjs
node contract-state-diff/tests/demo.mjs
```

Tests use controlled RPC responses. They cover changes, exact large values, malformed returns,
unknown propagation, wrong chain, reorganizations, saved baselines, RPC envelopes, timeouts,
credential-safe errors and tampered artifacts. These are local package checks; they do not install
a new verification profile on IMD. Catalogue admission and deployment remain maintainer work.

`examples/changed-report.md` and `examples/partial-report.md` are synthetic reports generated by
the last command. Their addresses, blocks and values are fixtures, not live observations.
