# pi-loop

A small [Pi](https://github.com/earendil-works/pi-coding-agent) extension for deterministic loop engineering.

For coding tasks, the loop's job is simple:

> Codify the expected functionality into tests, then loop until the test command passes.

The agent does the work. The extension orchestrates normal Pi turns, stores loop state, asks for training-mode approvals, and runs the authoritative verifier after each `loop_report`.

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

## Spec shape

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

Then the extension runs `verifyCommand` and decides:

```txt
exit 0       => done
exit nonzero => continue, or stop at maxIterations
blocked true => blocked
```

The agent no longer decides `done`; passing `verifyCommand` is the completion proof.

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```

## Safety

Every loop spec has:

- `verifyCommand`, the deterministic completion check.
- `maxIterations`, capped internally at 50.
- `trainingMode`; keep this `true` until the loop is trusted.

For fuzzy goals, add a checker or approval gate, for example `review score >= 8/10` or `human approved`.
