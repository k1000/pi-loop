---
name: tdd-loop
description: Design, create, run, and verify deterministic TDD loop-engineering workflows using the tdd_loop extension. Use when the user asks to build a loop, codify expected coding functionality as tests, create a TDD loop, split a complex feature into test-backed subloops, define completion verification, or run /tdd_loop commands.
---

# TDD Loop

Turn a coding task into a controlled, verifiable TDD loop. Pair with the `tdd` skill for execution.

> **Core:** codify expected functionality as behavior tests, one vertical slice at a time — write the test and the code in the same pass. The passing test command is the completion proof.

Do **not** write the whole suite first. Use tracer bullets: one failing behavior test → smallest fix → verifier passes → next behavior.

Every TDD iteration should also satisfy the test-quality contract: identify the behavior slice, consider likely failure modes and relevant edge cases, write one public-interface behavior test, confirm the red phase fails for the expected reason when practical, then implement only the smallest fix.

## Choose the shape

| Task | `mode` | Key fields |
|------|--------|------------|
| Small, one test | `tdd` | `taskPrompt`, `verifyCommand`, `maxIterations` |
| Medium, one suite | `tdd` | loop until the suite passes |
| Large, ordered steps | `test-plan` | `plan[]`, `maxIterationsPerStep`, `finalVerifyCommand?` |
| Large, independent parts | `dag-plan` | `plan[]` with `dependsOn`, `parallelism` |
| Fuzzy / subjective | any | first loop writes the test or checker, then stop for human approval |

## Before you loop (loopability gate)

A loop pays off only if all are true:

1. The task repeats across iterations.
2. The expected behavior can be expressed as a deterministic check (a test command).
3. Extra tokens/time are acceptable.
4. The verifier can actually run in this environment.

If the behavior can't be tested yet, the first loop goal is to **find the first behavior test** — not to bulk-write tests.

## Spec anatomy

**Single-test** (`mode: tdd`):

```json
{
  "name": "fix-login-bug",
  "goal": "Fix the login bug",
  "mode": "tdd",
  "taskPrompt": "Write/update one behavior-focused failing test for the login behavior, including its predictable failure mode, then implement the smallest fix. End by calling tdd_loop_report.",
  "verifyCommand": "npm test -- login.test.ts",
  "maxIterations": 5,
  "autoCommitEachStep": true
}
```

**Plan** (`test-plan` or `dag-plan`): same top-level fields plus `plan[]`. Each step carries its own `taskPrompt` + `verifyCommand`. `dag-plan` steps add `id` and `dependsOn[]`; `parallelism` (default 1) caps how many ready tasks are shown per iteration. `finalVerifyCommand?` runs a full-suite check after the last step passes.

```json
{
  "name": "onboarding",
  "goal": "Implement the onboarding flow",
  "mode": "dag-plan",
  "parallelism": 2,
  "maxIterationsPerStep": 3,
  "plan": [
    { "id": "draft",    "name": "Create draft applicant", "dependsOn": [],        "taskPrompt": "Write/update the draft test, then the smallest fix.", "verifyCommand": "npm test -- onboarding.draft.test.ts" },
    { "id": "validate", "name": "Validate fields",         "dependsOn": [],        "taskPrompt": "Write/update the validation test, then the smallest fix.", "verifyCommand": "npm test -- onboarding.validate.test.ts" },
    { "id": "kyc",      "name": "Submit to KYC",           "dependsOn": ["draft"], "taskPrompt": "Write/update the KYC test, then the smallest fix.", "verifyCommand": "npm test -- onboarding.kyc.test.ts" }
  ],
  "finalVerifyCommand": "npm test -- onboarding"
}
```

Drop `dependsOn` and set `mode: "test-plan"` for the same shape run strictly in order. Full worked examples live in `README.md`.

## Create and run

```txt
/tdd_loop:new <name>          # writes .pi/loops/specs/<name>.json
/tdd_loop:run <name-or-path>  # starts a run
```

Each iteration: do one focused unit of work (write/update one failing behavior test → smallest fix per the `tdd` skill), then call `tdd_loop_report` **exactly once**.

Test-quality checklist per iteration:

- Identify the smallest behavior slice under test.
- Consider happy path, boundary/empty/invalid inputs, regression/predictable failure, and ordering/idempotency/concurrency/persistence/permission risks if relevant.
- Test observable behavior through the public interface; avoid private methods and mock choreography.
- Run the targeted test before implementation when practical; confirm it fails for the expected reason.
- Before reporting, check the test would fail against the old/broken behavior and mention intentionally deferred edge cases.

You do **not** decide completion. After your report the extension runs the current verifier:

- exit `0` → step/task done → next eligible work (or loop complete)
- non-zero → retry the same step/task (until `maxIterationsPerStep` / `maxIterations`)
- `blocked: true` → loop stops as blocked

After a step verifier passes, tdd_loop auto-commits the completed step by default if there are working-tree changes. Failed iterations are kept uncommitted for the next attempt.

In `test-plan`, the next step unlocks only after the current step's verifier passes. In `dag-plan`, only ready tasks (all `dependsOn` done) are shown; set `tdd_loop_report.taskId` if you pick a ready task other than the suggested one.

## tdd_loop_report fields

| Field | When |
|-------|------|
| `summary` | always — what changed this iteration |
| `blocked` | true only for human input, missing access, ambiguity, or unsafe action |
| `taskId` | `dag-plan` only — the ready task you worked on |
| `nextPrompt` | optional hint if the verifier still fails |
| `artifacts` | changed files / commands |
| `lessonsLearned` | reusable lessons worth persisting |

Never claim completion — passing the verifier is the proof.

## Delegated DAG execution

For large independent work, use `mode: "dag-plan"` and let the main agent act as orchestrator. Delegation is safe only when task ownership is explicit.

Main-agent responsibilities:

- Decompose the goal into DAG steps with narrow `verifyCommand`s.
- Put expected file ownership / no-touch boundaries in each `taskPrompt`.
- Delegate only ready DAG tasks whose file ownership is disjoint.
- Review returned work before reporting.
- Call `tdd_loop_report` for exactly one completed ready task; the extension verifies and advances.

Subagent contract:

```txt
You own only this TDD loop task.
Allowed file ownership: <paths/globs>.
Write or update one behavior-focused failing test through the public interface.
Implement the smallest fix for this behavior only.
Do not refactor unrelated code or touch files outside ownership; stop and explain if required.
Run: <verifyCommand>.
Return: changed files, command result, old-behavior failure rationale, deferred edge cases, and integration risks.
```

Start with `parallelism: 2`. Parallelize leaf UI/tests/adapters/docs. Serialize core domain services, schema, migrations, shared types, fixtures, and any task likely to touch the same files.

## Guardrails

- Keep `maxIterations`, `maxIterationsPerStep`, and `parallelism` low until the loop proves useful.
- Prefer specific test commands over broad suites.
- Break subjective work into sub-loops with an explicit checker or approval gate.
- Prefer specialist skills for execution; the loop orchestrates, tests verify.

## Stop

```txt
/tdd_loop:stop
```

Run memory is written to `.pi/loops/runs/<name>/` (a `.json` state file + a `.md` log per run). Live status shows in the Pi UI widget.

Default behavior: after each completed step, tdd_loop creates a local git commit when the working tree has changes. Failed iterations are not committed. Set `"autoCommitEachStep": false` in an individual loop spec to opt out.
