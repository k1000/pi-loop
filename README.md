# tdd_loop

A small [Pi](https://github.com/earendil-works/pi-coding-agent) extension for deterministic TDD loop engineering.

For coding tasks, pair tdd_loop with Pi's `tdd` skill. The loop's job is simple:

> Codify expected functionality as behavior tests, one vertical slice at a time — writing the test and the code in the same pass — then loop until the test command passes.

Avoid bulk-writing all tests first. Prefer TDD tracer bullets: one failing behavior test → minimal implementation → passing verifier → next behavior.

Each TDD iteration includes a test-quality contract: identify the behavior slice, consider likely failure modes and relevant edge cases, write one public-interface behavior test, confirm the red phase fails for the expected reason when practical, then implement only the smallest fix.

## Install

Clone into Pi's global extension directory:

```bash
git clone https://github.com/k1000/tdd_loop.git ~/.pi/agent/extensions/tdd_loop
```

Then restart Pi or run:

```txt
/reload
```

## Commands

```txt
/tdd_loop:new <name>          # create .pi/loops/specs/<name>.json
/tdd_loop:run <name-or-path>  # start a loop run
/tdd_loop:stop                # stop active loop
```

You can also use:

```txt
/tdd_loop new|run|stop ...
```

The Pi UI widget shows live status while a loop runs.

## Skill

The package includes a skill:

```txt
/skill:tdd_loop
```

Use it to design deterministic loop specs and turn expected coding functionality into test-based completion criteria.

## Choose the shape

| Task | `mode` | Key fields |
|------|--------|------------|
| Small, one test | `tdd` | `taskPrompt`, `verifyCommand`, `maxIterations` |
| Medium, one suite | `tdd` | loop until the suite passes |
| Large, ordered steps | `test-plan` | `plan[]`, `maxIterationsPerStep`, `finalVerifyCommand?` |
| Large, independent parts | `dag-plan` | `plan[]` with `dependsOn`, `parallelism` |
| Fuzzy / subjective | any | first loop writes the test or checker, then stop for human approval |

## Single-test spec

```json
{
  "name": "fix-login-bug",
  "goal": "Fix the login bug",
  "mode": "tdd",
  "taskPrompt": "First write or update one behavior-focused failing test that proves the login behavior and its predictable failure mode. Then implement the smallest fix. End by calling tdd_loop_report.",
  "verifyCommand": "npm test -- login.test.ts",
  "maxIterations": 5,
  "autoCommitEachStep": true
}
```

## Plan spec (`test-plan` or `dag-plan`)

`test-plan` runs steps strictly in order. `dag-plan` is the same shape with `dependsOn` so independent tasks unlock as their dependencies pass — only ready tasks are surfaced per iteration, and the agent picks one.

```json
{
  "name": "onboarding-parallel",
  "goal": "Implement independent onboarding pieces",
  "mode": "dag-plan",
  "parallelism": 2,
  "maxIterationsPerStep": 3,
  "plan": [
    { "id": "draft",    "name": "Creates draft applicant", "dependsOn": [],        "taskPrompt": "Write/update the draft test, then implement the smallest fix.", "verifyCommand": "npm test -- onboarding.create-draft.test.ts" },
    { "id": "validate", "name": "Validates required fields", "dependsOn": [],        "taskPrompt": "Write/update the validation test, then implement the smallest fix.", "verifyCommand": "npm test -- onboarding.validation.test.ts" },
    { "id": "kyc",      "name": "Submits to KYC",            "dependsOn": ["draft"], "taskPrompt": "Write/update the KYC test, then implement the smallest fix.", "verifyCommand": "npm test -- onboarding.kyc-submit.test.ts" }
  ],
  "finalVerifyCommand": "npm test -- onboarding"
}
```

Drop `dependsOn` and set `mode: "test-plan"` for the strictly-ordered variant.

## Deterministic runtime protocol

`/tdd_loop:run` sends an iteration prompt. The agent does one focused unit of work — write/update one failing test, implement the smallest fix — then calls `tdd_loop_report` with progress only:

```json
{
  "summary": "Added login regression test and fixed token parsing.",
  "blocked": false,
  "nextPrompt": "If still failing, inspect cookie handling.",
  "artifacts": ["tests/login.test.ts", "src/auth.ts"]
}
```

Before reporting, the agent should check that the new test would fail against the old/broken behavior, avoid implementation-coupled assertions, and mention relevant edge cases intentionally deferred.

The extension then runs the current verifier and decides:

```txt
exit 0       => step/task done, unlock next eligible work, or finish loop
exit nonzero => continue same step/task, or stop at maxIterations
blocked true => blocked
```

In `dag-plan` mode, the agent may set `tdd_loop_report.taskId` to choose among currently-ready independent tasks. The agent never decides `done`; passing the current verifier is the completion proof.

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```

By default, each completed step creates a local git commit when the working tree has changes. Failed iterations are not committed. Set `"autoCommitEachStep": false` in a loop spec to opt out for that loop.

## Safety

Every loop spec has:

- `verifyCommand` or a test-backed `plan`.
- `dependsOn` for DAG tasks that must wait for other tests to pass.
- `maxIterations`, capped internally at 50.
- `maxIterationsPerStep` for test/DAG plans.
- `autoCommitEachStep`, defaulting to `true`, to create a local commit after each completed step when changes exist.

For fuzzy goals, first create a test plan or add a checker/approval gate, for example `review score >= 8/10` or `human approved`.
