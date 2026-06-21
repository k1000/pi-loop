---
name: pi-loop
description: Design, create, run, and verify Pi loop-engineering workflows using the pi-loop extension. Use when the user asks to build a loop, loop orchestration spec, repeated agent workflow, training-mode loop, verification loop, or to run /loop commands.
---

# Pi Loop

Use this skill when turning repeated prompting into a controlled Pi loop.

## Loopability check

Before creating or running a loop, confirm the task passes the four-condition test:

1. The task repeats across iterations.
2. There is a clear definition of done.
3. Extra tokens/time are acceptable.
4. The loop has the tools/skills needed to verify progress.

If any condition is weak, ask the user to clarify or propose a smaller sub-loop.

## Create a loop spec

Prefer the extension command:

```txt
/loop:new <loop-name>
```

A good spec includes:

- `goal`: concrete task outcome.
- `doneRule`: checkable completion signal.
- `iterationPrompt`: one focused iteration, not the whole project.
- `maxIterations`: small default, usually 3-5.
- `trainingMode`: `true` until the loop is trusted.
- `verificationHint`: deterministic commands/checks where possible. For coding tasks, prefer TDD style: first write or update a failing test; completion verification is that the test passes.

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
2. Verify against the `doneRule`.
3. End by calling `loop_report` exactly once.

Use `loop_report` statuses:

- `done`: verification proves the goal is complete.
- `not_done`: another iteration is useful; include `nextPrompt`.
- `blocked`: human input, missing access, ambiguity, or unsafe next step.

Never call `loop_report(status="done")` without verification evidence. For code changes, the first useful loop action is often to add or update the failing test; the completion proof is the passing test.

## Guardrails

- Keep `trainingMode: true` for new loops.
- Keep `maxIterations` low until the loop proves useful.
- Break subjective work into sub-loops with approval or scoring gates.
- Prefer using existing specialist skills for execution; the loop orchestrates, skills do the work.
- Persist lessons in the run report via `lessonsLearned` when reusable.

## Inspect or stop

```txt
/loop:status
/loop:stop
```

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```
