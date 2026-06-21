# pi-loop

A small [Pi](https://github.com/earendil-works/pi-coding-agent) extension for deterministic loop engineering.

For coding tasks, the loop's job is simple:

> Codify the expected functionality into tests, then loop until the test command passes.

For larger features, use a **test plan**: an ordered list of test-backed steps. Pi-loop satisfies one step verifier at a time, advances only when that verifier passes, then optionally runs a final full-suite verifier.

For features with independent parts, use a **DAG plan**: declare dependencies with `dependsOn`. Pi-loop exposes ready tasks whose dependencies have passed, lets the agent work on one ready task per iteration, and unlocks dependent tasks deterministically.

## Install

Clone into Pi's global extension directory:

```bash
git clone https://github.com/k1000/pi-loop.git ~/.pi/agent/extensions/pi-loop
```

Then restart Pi or run:

```txt
/reload
```

## Commands

```txt
/loop:new <name>          # create .pi/loops/specs/<name>.json
/loop:run <name-or-path>  # start a loop run
/loop:status              # show active loop status
/loop:stop                # stop active loop
```

You can also use:

```txt
/loop new|run|status|stop ...
```

## Skill

The package includes a skill:

```txt
/skill:pi-loop
```

Use it to design deterministic loop specs and turn expected coding functionality into test-based completion criteria.

## Single-test spec

Use this for small/medium tasks:

```json
{
  "name": "fix-login-bug",
  "goal": "Fix the login bug",
  "mode": "tdd",
  "taskPrompt": "First write or update a failing test that proves the login behavior. Then implement the smallest fix. End by calling loop_report.",
  "verifyCommand": "npm test -- login.test.ts",
  "doneWhen": "verifyCommand exits 0",
  "maxIterations": 5,
  "trainingMode": true
}
```

## Test-plan spec

Use this for larger features that should be decomposed into multiple tests:

```json
{
  "name": "onboarding-feature",
  "goal": "Implement the onboarding flow",
  "mode": "test-plan",
  "maxIterationsPerStep": 3,
  "trainingMode": true,
  "plan": [
    {
      "name": "creates draft applicant",
      "taskPrompt": "Write or update the draft applicant test, then implement the smallest behavior needed for it.",
      "verifyCommand": "npm test -- onboarding.create-draft.test.ts",
      "doneWhen": "verifyCommand exits 0"
    },
    {
      "name": "validates required fields",
      "taskPrompt": "Write or update required-field validation tests, then implement the smallest behavior needed for them.",
      "verifyCommand": "npm test -- onboarding.validation.test.ts",
      "doneWhen": "verifyCommand exits 0"
    },
    {
      "name": "handles approval webhook",
      "taskPrompt": "Write or update approval webhook tests, then implement the smallest behavior needed for them.",
      "verifyCommand": "npm test -- onboarding.webhook-approved.test.ts",
      "doneWhen": "verifyCommand exits 0"
    }
  ],
  "finalVerifyCommand": "npm test -- onboarding"
}
```

State machine:

```txt
for each plan step:
  agent works on current test-backed step
  agent calls loop_report
  extension runs step verifyCommand
  exit 0 => advance to next step
  nonzero => retry same step, or stop at maxIterationsPerStep

then, if configured:
  extension runs finalVerifyCommand
  exit 0 => done
  nonzero => queue integration/regression fix iteration
```

## DAG-plan spec

Use this when feature tasks do not all depend on each other:

```json
{
  "name": "onboarding-parallel",
  "goal": "Implement independent onboarding pieces",
  "mode": "dag-plan",
  "parallelism": 2,
  "maxIterationsPerStep": 3,
  "trainingMode": true,
  "plan": [
    {
      "id": "draft-applicant",
      "name": "Creates draft applicant",
      "dependsOn": [],
      "taskPrompt": "Write/update the draft applicant test, then implement the smallest behavior needed for it.",
      "verifyCommand": "npm test -- onboarding.create-draft.test.ts"
    },
    {
      "id": "field-validation",
      "name": "Validates required fields",
      "dependsOn": [],
      "taskPrompt": "Write/update validation tests, then implement the smallest behavior needed for them.",
      "verifyCommand": "npm test -- onboarding.validation.test.ts"
    },
    {
      "id": "submit-kyc",
      "name": "Submits to KYC",
      "dependsOn": ["draft-applicant"],
      "taskPrompt": "Write/update KYC submit tests, then implement the smallest behavior needed for them.",
      "verifyCommand": "npm test -- onboarding.kyc-submit.test.ts"
    }
  ],
  "finalVerifyCommand": "npm test -- onboarding"
}
```

This is safe pseudo-parallelism in one Pi session: the prompt lists ready independent task ids. The agent works on one ready task and can set `loop_report.taskId`. True parallel worktrees can be added later, but this mode keeps one checkout deterministic.

## Deterministic runtime protocol

`/loop:run` sends an iteration prompt to the agent. The agent must finish each iteration by calling `loop_report` with progress only:

```json
{
  "summary": "Added login regression test and fixed token parsing.",
  "blocked": false,
  "nextPrompt": "If still failing, inspect cookie handling.",
  "artifacts": ["tests/login.test.ts", "src/auth.ts"]
}
```

Then the extension runs the current verifier and decides:

```txt
exit 0       => step/task done, unlock next eligible work, or finish loop
exit nonzero => continue same step/task, or stop at maxIterations
blocked true => blocked
```

In `dag-plan` mode, the agent may include `taskId` in `loop_report` to choose among currently-ready independent tasks. The agent does not decide `done`; passing the current verifier is the completion proof.

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```

## Safety

Every loop spec has:

- `verifyCommand` or a test-backed `plan`.
- `dependsOn` for DAG tasks that must wait for other tests to pass.
- `maxIterations`, capped internally at 50.
- `maxIterationsPerStep` for test/DAG plans.
- `trainingMode`; keep this `true` until the loop is trusted.

For fuzzy goals, first create a test plan or add a checker/approval gate, for example `review score >= 8/10` or `human approved`.
