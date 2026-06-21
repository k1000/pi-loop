# pi-loop

A small [Pi](https://github.com/earendil-works/pi-coding-agent) extension for deterministic loop engineering.

For coding tasks, the loop's job is simple:

> Codify the expected functionality into tests, then loop until the test command passes.

For larger features, use a **test plan**: an ordered list of test-backed steps. Pi-loop satisfies one step verifier at a time, advances only when that verifier passes, then optionally runs a final full-suite verifier.

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
exit 0       => step done / loop done
exit nonzero => continue, or stop at maxIterations
blocked true => blocked
```

The agent does not decide `done`; passing the current verifier is the completion proof.

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```

## Safety

Every loop spec has:

- `verifyCommand` or a test-backed `plan`.
- `maxIterations`, capped internally at 50.
- `maxIterationsPerStep` for test plans.
- `trainingMode`; keep this `true` until the loop is trusted.

For fuzzy goals, first create a test plan or add a checker/approval gate, for example `review score >= 8/10` or `human approved`.
