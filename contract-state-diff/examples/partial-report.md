# Contract state diff

Chain: 1. Source label: synthetic-fixture.
Configuration SHA-256: 517cea824364cac4908cd36d4c610f39fbbac6056af7f34c06fbb7dfdd0f0048.

From: 10 (0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).
To: 11 (0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb).
Earlier values: rpc.

Coverage: partial; 0 changed, 0 unchanged, 1 unknown, 0 baseline-only.

| Field | Status | Before | After |
| --- | --- | --- | --- |
| owner | unknown | 0x2222222222222222222222222222222222222222 | unknown (rpc_error: -32000) |

## Interpretation

- Only the configured calls were observed. No complete privilege inventory or event history was collected.
- Two snapshots miss temporary changes later reversed. Unchanged fields are not a safety verdict.
- Unknown means a read failed or could not be decoded; it never means zero, false, or unchanged.
- Baseline-only establishes values without asserting a change or lack of change.
- Hash-pinned reads and header rechecks detect some source inconsistencies; they do not prove provider honesty or chain finality.
- Saved baseline values are supplied evidence, not authenticated history. Their block and configuration are rechecked.
- Class 2 artifact validation does not independently rerun RPC observations or authorize money movement or launch.

Reproduce with config.json and the recorded block numbers using an authorized IMD_RPC_URL.
Check that the reproduced block hashes match. Endpoint URLs and provider messages are omitted to avoid leaking credentials.
