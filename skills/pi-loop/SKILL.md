---
name: pi-loop
description: Design, create, run, and verify deterministic Pi loop-engineering workflows using the pi-loop extension. Use when the user asks to build a loop, codify expected coding functionality as tests, create a TDD loop, split a complex feature into test-backed subloops, define completion verification, or run /loop commands.
---

# Pi Loop

Use this skill when turning repeated prompting into a controlled, verifiable Pi loop.

For coding tasks, the core skill is:

> Codify the expected functionality into a suite of tests. Completion verification is the passing test command.

## Choose the loop shape

- Small task: one loop with one `verifyCommand`.
- Medium task: one test file/suite, loop until that suite passes.
- Large feature: `test-plan` mode — ordered test-backed steps, one verifier per step, optional final verifier.
- Fuzzy feature: first loop writes the test plan/checker, then stop for human approval.

## Loopability check

Before creating or running a loop, confirm:

1. The task repeats across iterations.
2. The expected behavior can be expressed as tests or another deterministic check.
3. Extra tokens/time are acceptable.
4. The loop has the tools/skills needed to run the verifier.

If the expected behavior cannot be tested yet, the first loop goal should be to write the tests or test plan.

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

## Run a loop

Use:

```txt
/loop:run <loop-name-or-path>
```

During each iteration, the agent must:

1. Do one focused unit of work.
2. For coding tasks, write/update the test before or alongside the implementation.
3. End by calling `loop_report` exactly once.

The agent does **not** decide completion. After `loop_report`, the extension runs the current verifier:

- exit code `0` → current step is `done`; next step starts or loop completes
- non-zero exit code → same step continues or hits `maxIterationsPerStep` / `maxIterations`
- `blocked: true` in `loop_report` → loop stops as `blocked`

## loop_report protocol

Use `loop_report` only to report progress:

- `summary`: what changed this iteration.
- `blocked`: true only for human input, missing access, ambiguity, or unsafe action.
- `nextPrompt`: optional hint for the next iteration if the verifier still fails.
- `artifacts`: changed files or useful commands.
- `lessonsLearned`: reusable lessons worth persisting.

Never claim completion in `loop_report`; passing the current verifier is the completion proof.

## Guardrails

- Keep `trainingMode: true` for new loops.
- Keep `maxIterations` and `maxIterationsPerStep` low until the loop proves useful.
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
