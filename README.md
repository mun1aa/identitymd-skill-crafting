# identitymd-skill-crafting

How to write a `SKILL.md` that the [identity.md](https://imd.fun) network can compile, dispatch to
contributors' machines, and judge. Hand this folder to your AI and ask for a skill; check the result
with one command.

A skill on this network is a file that tells one node of a job what it is for: the objective, the
criteria its work is judged against, the write budget, the judge that decides whether it counts, and
background an expert would give. It runs on a stranger's machine, under Claude Code or Codex, inside
rules the file cannot change. That is why the format is stricter than skills written for your own
laptop.

## What is here

| Path | What it is |
| --- | --- |
| [`skill-authoring/SKILL.md`](skill-authoring/SKILL.md) | The guide: runnable skills vs references, every frontmatter field (`writes` budget, `judge`, `checks`, `requires`, `reads`, `mustProduce`, `inference`, provenance), how to write the body, and a checklist |
| [`skill-authoring/REFERENCE.md`](skill-authoring/REFERENCE.md) | Complete skeleton files to start from |
| [`examples/`](examples) | Real skills from the network's catalog, copied as they are |
| [`check-skill.mjs`](check-skill.mjs) | The catalog's own validation rules, runnable on your file. Node 18+, no dependencies |

The examples cover the main shapes:

| Example | Shape |
| --- | --- |
| `implement-one-contract` | Runnable, re-run by the verifier (class 1), budget set per job, a second variable |
| `fix-findings` | Runnable, class 1, `writes: any`, a narrow body |
| `adversarial-review` | Review, `writes: none` |
| `create-image` | Runnable with no suite: `checks: none` + `verifier-paths` (class 2), needs `tool:image` |
| `oracle-assess` | Fixed output paths, `reads` of its own guide and scripts, `inference: economy` (its `scripts/` and `REFERENCE.md` are not copied here) |
| `solidity-security-review` | A reference: knowledge only, attached to other work |

## Use it with your AI

Give your assistant `skill-authoring/SKILL.md` and `skill-authoring/REFERENCE.md` (attach them, paste
them, or point it at this repository), plus whichever example is closest to what you want. Then:

```
Read skill-authoring/SKILL.md and skill-authoring/REFERENCE.md. Using them, write
<id>/SKILL.md for an identity.md skill that <what the node should do>.

Decide first whether it is a runnable skill or a reference, and say why.
Use the smallest writes budget that works, a judge that matches what the verifier
can actually check, and acceptance criteria a person could verify from the
delivered files alone. It must work under both Claude Code and Codex.

When done, run: node check-skill.mjs <id>
and fix everything it reports.
```

## Check a skill

The folder must be named after the skill's `id`:

```
node check-skill.mjs my-skill
node check-skill.mjs my-skill another-skill examples/*
```

```
ok  fix-findings v2: implement, judge verifier-rerun (class 1), checks foundry
bad my-skill/SKILL.md: judge must be one of verifier-rerun, verifier-replay, verifier-paths, control-plane-recheck, panel-agreement — got model
```

A pass means the network's catalog build would accept the file. It does not mean the skill is good:
the checklist at the end of `SKILL.md` covers the parts that need a human read.

## Paths the guide mentions

The guide is the same file the network ships in its catalog, so it names paths in the protocol
repository — `skills/README.md`, `scripts/generate-skills.mjs`, `pnpm skills:generate`,
`packages/daemon/src/task/prompt.ts`. You do not need them to write a skill; `check-skill.mjs` applies
the same rules. Paths under `.imd/reads/` are where a worker finds its pinned inputs during a run.

## Proposing a skill for the network

Open an issue or a pull request on this repository with your skill folder and a sentence on why no
existing skill covers it. A skill copied from someone else must carry `upstream`, `upstreamCommit`
(a full 40-character commit) and `licence`, with the licence file beside it.

## Proposed skills

These packages are proposals, not claims of admission to the live catalog.

| Package | Purpose | Validation |
| --- | --- | --- |
| [`contract-state-diff`](contract-state-diff/SKILL.md) | Compare selected EVM fields across pinned blocks or a saved baseline, preserving unknown reads and typed evidence. Runnable, class 2. | `node check-skill.mjs contract-state-diff` and `node --test contract-state-diff/tests/*.test.mjs` |

The package's [reference](contract-state-diff/REFERENCE.md) describes inputs, output, failure
semantics and how it differs from entry-point analysis and single-call oracle comparisons.
