---
name: pi-loop
description: Design, create, run, and verify deterministic Pi loop-engineering workflows using the pi-loop extension. Use when the user asks to build a loop, codify expected coding functionality as tests, create a TDD loop, define completion verification, or run /loop commands.
---

# Pi Loop

Use this skill when turning repeated prompting into a controlled, verifiable Pi loop.

For coding tasks, the core skill is:

> Codify the expected functionality into a suite of tests. Completion verification is the passing test command.

## Loopability check

Before creating or running a loop, confirm:

1. The task repeats across iterations.
2. The expected behavior can be expressed as tests or another deterministic check.
3. Extra tokens/time are acceptable.
4. The loop has the tools/skills needed to run the verifier.

If the expected behavior cannot be tested yet, the first loop goal should be to write the tests.

## Create a deterministic loop spec

Prefer:

```txt
/loop:new <loop-name>
```

A good spec includes:

- `goal`: concrete expected functionality.
- `mode`: use `tdd` for coding tasks.
- `taskPrompt`: tell the agent to first write/update the failing test, then implement the smallest fix.
- `verifyCommand`: the authoritative test command.
- `doneWhen`: usually `verifyCommand exits 0`.
- `maxIterations`: small default, usually 3-5.
- `trainingMode`: `true` until the loop is trusted.

Default spec location:

```txt
.pi/loops/specs/<loop-name>.json
```

## Run a loop

Use:

```txt
/loop:run <loop-name-or-path>
```

During each iteration, the agent must:

1. Do one focused unit of work.
2. For coding tasks, write/update the test before or alongside the implementation.
3. End by calling `loop_report` exactly once.

The agent does **not** decide completion. After `loop_report`, the extension runs `verifyCommand`:

- exit code `0` → loop is `done`
- non-zero exit code → loop continues or hits `maxIterations`
- `blocked: true` in `loop_report` → loop stops as `blocked`

## loop_report protocol

Use `loop_report` only to report progress:

- `summary`: what changed this iteration.
- `blocked`: true only for human input, missing access, ambiguity, or unsafe action.
- `nextPrompt`: optional hint for the next iteration if the verifier still fails.
- `artifacts`: changed files or useful commands.
- `lessonsLearned`: reusable lessons worth persisting.

Never claim completion in `loop_report`; passing `verifyCommand` is the completion proof.

## Guardrails

- Keep `trainingMode: true` for new loops.
- Keep `maxIterations` low until the loop proves useful.
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
