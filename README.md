# pi-loop

A small [Pi](https://github.com/earendil-works/pi-coding-agent) extension for loop engineering: repeat normal agent turns until a clearly defined, verifiable goal is reached.

The extension does not do the work itself. It orchestrates Pi turns, keeps loop state, asks for training-mode approvals, and requires the agent to report each iteration with a structured `loop_report` tool call.

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

Use it to design loop specs, check whether a task is loopable, and make approval criteria deterministic.

## Runtime protocol

`/loop:run` sends an iteration prompt to the agent. The agent must finish each iteration by calling `loop_report` with:

- `status: "done"` — verification proves the definition of done is satisfied.
- `status: "not_done"` — another iteration should run; include `nextPrompt`.
- `status: "blocked"` — human input, missing access, ambiguity, or unsafe next step.

Run memory is written by default to:

```txt
.pi/loops/runs/<loop-name>/
```

## What makes a good loop?

A good loop spec turns vague work into small actions plus deterministic acceptance criteria:

```txt
Goal: make X true.
Iteration: do one small step toward X.
Verification: run/check Y.
Done: Y passes, returns the expected value, reaches a threshold, or a human approves.
```

Examples of strong `doneRule` values:

- `npm test exits 0`
- `pytest tests/foo passes`
- `curl /health returns HTTP 200`
- `backtest Sharpe > 1.2 and max drawdown < 10%`
- `human approval received in training mode`

## Safety

Every loop spec has:

- `maxIterations`, capped internally at 50.
- `trainingMode`; keep this `true` until the loop is trusted.
- `doneRule`; the agent should not report `done` without verification evidence.

For fuzzy goals, add a checker or approval gate, for example `review score >= 8/10` or `human approved`.
