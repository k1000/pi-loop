---
name: pi-loop
description: Design, create, run, and verify deterministic Pi loop-engineering workflows using the pi-loop extension. Use when the user asks to build a loop, codify expected coding functionality as tests, create a TDD loop, split a complex feature into test-backed subloops, define completion verification, or run /loop commands.
---

# Pi Loop

Use this skill when turning repeated prompting into a controlled, verifiable Pi loop.

For coding tasks, pair this with the `tdd` skill. The core loop skill is:

> Codify expected functionality as behavior tests, one vertical slice at a time. Completion verification is the passing test command.

Do **not** write all tests first and then all implementation. Use TDD tracer bullets: one failing behavior test → minimal implementation → passing verifier → next behavior.

## Choose the loop shape

- Small task: one loop with one `verifyCommand`.
- Medium task: one test file/suite, loop until that suite passes.
- Large sequential feature: `test-plan` mode — ordered TDD tracer bullets, one verifier per step, optional final verifier.
- Large feature with independent parts: `dag-plan` mode — independent TDD tracer bullets with `dependsOn`, ready tasks unlocked by passing verifiers.
- Fuzzy feature: first loop writes the test plan/checker, then stop for human approval.

## Loopability check

Before creating or running a loop, confirm:

1. The task repeats across iterations.
2. The expected behavior can be expressed as tests or another deterministic check.
3. Extra tokens/time are acceptable.
4. The loop has the tools/skills needed to run the verifier.

If the expected behavior cannot be tested yet, the first loop goal should be to identify the first behavior test/tracer bullet, not to bulk-write the entire suite.

## Single-test loop spec

Prefer:

```txt
/loop:new <loop-name>
```

A good single-test spec includes:

- `goal`: concrete expected functionality.
- `mode`: use `tdd` for coding tasks.
- `taskPrompt`: tell the agent to first write/update the failing test, then implement the smallest fix.
- `verifyCommand`: the authoritative test command.
- `doneWhen`: usually `verifyCommand exits 0`.
- `maxIterations`: small default, usually 3-5.
- `trainingMode`: `true` until the loop is trusted.

## Test-plan loop spec

For complex features, prefer `mode: "test-plan"` instead of one vague loop.

Use an ordered plan:

```json
{
  "name": "onboarding-feature",
  "goal": "Implement onboarding flow",
  "mode": "test-plan",
  "maxIterationsPerStep": 3,
  "trainingMode": true,
  "plan": [
    {
      "name": "creates draft applicant",
      "taskPrompt": "Write/update the draft applicant test, then implement the smallest behavior needed for it.",
      "verifyCommand": "npm test -- onboarding.create-draft.test.ts",
      "doneWhen": "verifyCommand exits 0"
    },
    {
      "name": "validates required fields",
      "taskPrompt": "Write/update validation tests, then implement the smallest behavior needed for them.",
      "verifyCommand": "npm test -- onboarding.validation.test.ts",
      "doneWhen": "verifyCommand exits 0"
    }
  ],
  "finalVerifyCommand": "npm test -- onboarding"
}
```

The extension advances to the next plan step only after the current step's `verifyCommand` exits 0. After the last step, it runs `finalVerifyCommand` if configured.

## DAG-plan loop spec

For complex features with independent tasks, prefer `mode: "dag-plan"`.

Use dependencies instead of a forced linear order:

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

This is safe pseudo-parallelism: the extension lists ready independent task ids and the agent works on one ready task per iteration. If the agent chooses a ready task other than the suggested one, it must set `loop_report.taskId`.

## Run a loop

Use:

```txt
/loop:run <loop-name-or-path>
```

During each iteration, the agent must:

1. Do one focused unit of work.
2. For coding tasks, follow the `tdd` skill: write/update one failing behavior test, implement the smallest fix, then let the verifier prove it passes.
3. End by calling `loop_report` exactly once.

The agent does **not** decide completion. After `loop_report`, the extension runs the current verifier:

- exit code `0` → current step/task is `done`; next eligible work starts or loop completes
- non-zero exit code → same step/task continues or hits `maxIterationsPerStep` / `maxIterations`
- `blocked: true` in `loop_report` → loop stops as `blocked`

## loop_report protocol

Use `loop_report` only to report progress:

- `taskId`: optional; for `dag-plan`, the ready task id worked on this iteration.
- `summary`: what changed this iteration.
- `blocked`: true only for human input, missing access, ambiguity, or unsafe action.
- `nextPrompt`: optional hint for the next iteration if the verifier still fails.
- `artifacts`: changed files or useful commands.
- `lessonsLearned`: reusable lessons worth persisting.

Never claim completion in `loop_report`; passing the current verifier is the completion proof.

## Guardrails

- Keep `trainingMode: true` for new loops.
- Keep `maxIterations`, `maxIterationsPerStep`, and `parallelism` low until the loop proves useful.
- Prefer specific test commands over broad suites when possible.
- Break subjective work into sub-loops with an explicit checker or approval gate.
- Prefer existing specialist skills for execution; the loop orchestrates, tests verify.

## Inspect or stop

```txt
/loop:status
/loop:stop
```

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```
