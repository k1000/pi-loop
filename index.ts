import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const LOOP_CONFIG_DIR = ".pi";
const GLOBAL_LOOP_DIR = join(homedir(), ".pi", "agent", "loops");
const MAX_SAFE_ITERATIONS = 50;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_ITERATIONS_PER_STEP = 3;

type LoopStatus = "done" | "not_done" | "blocked";
type RunStatus = "running" | "done" | "blocked" | "stopped" | "max_iterations";
type LoopMode = "tdd" | "standard" | "test-plan" | "dag-plan";

type LoopStep = {
  id: string;
  name: string;
  taskPrompt: string;
  verifyCommand: string;
  doneWhen: string;
  dependsOn: string[];
};

type LoopSpec = {
  name: string;
  goal: string;
  mode: LoopMode;
  taskPrompt: string;
  verifyCommand: string;
  doneWhen: string;
  maxIterations: number;
  maxIterationsPerStep: number;
  trainingMode: boolean;
  memoryPath?: string;
  verifyTimeoutMs: number;
  plan: LoopStep[];
  finalVerifyCommand?: string;
  parallelism: number;
};

const LoopReportSchema = Type.Object({
  taskId: Type.Optional(Type.String({ description: "For dag-plan loops, the ready task id completed or attempted in this iteration. Omit to use the current suggested task." })),
  summary: Type.String({ description: "Concise summary of what happened in this iteration." }),
  blocked: Type.Optional(Type.Boolean({ description: "Set true only when human input, missing access, ambiguity, or an unsafe next step blocks progress." })),
  nextPrompt: Type.Optional(Type.String({ description: "Specific prompt for the next iteration if the verifier still fails." })),
  artifacts: Type.Optional(Type.Array(Type.String(), { description: "Files, commands, URLs, or other artifacts created/changed/checked." })),
  lessonsLearned: Type.Optional(Type.Array(Type.String(), { description: "Reusable lessons to persist in loop run memory." })),
});

type LoopReport = Static<typeof LoopReportSchema>;

type HistoryEntry = LoopReport & {
  iteration: number;
  stepIteration: number;
  stepIndex?: number;
  stepId?: string;
  stepName?: string;
  timestamp: string;
  status: LoopStatus;
  verification: string;
  verifyCommand?: string;
  verifyExitCode?: number | null;
  verifyStdout?: string;
  verifyStderr?: string;
};

type ActiveRun = {
  runId: string;
  cwd: string;
  specPath: string;
  runPath: string;
  logPath: string;
  spec: LoopSpec;
  iteration: number;
  stepIteration: number;
  currentStepIndex: number;
  currentTaskId?: string;
  completedTaskIds: string[];
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  history: HistoryEntry[];
};

function sanitizeName(name: string) {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "loop";
}

function nowStamp() {
  return new Date().toISOString();
}

function fileStamp() {
  return nowStamp().replace(/[:.]/g, "-");
}

function projectLoopDir(cwd: string) {
  return join(cwd, LOOP_CONFIG_DIR, "loops");
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function trunc(text: unknown, max = 4000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeStep(raw: unknown, index: number, fallback: Pick<LoopStep, "taskPrompt" | "verifyCommand" | "doneWhen">): LoopStep {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopStep>;
  const name = String(input.name || `step-${index + 1}`);
  const id = sanitizeName(String(input.id || name || `step-${index + 1}`));
  const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map((dep) => sanitizeName(String(dep))).filter(Boolean) : [];
  return {
    id,
    name,
    taskPrompt: String(input.taskPrompt || fallback.taskPrompt),
    verifyCommand: String(input.verifyCommand || fallback.verifyCommand),
    doneWhen: String(input.doneWhen || fallback.doneWhen),
    dependsOn,
  };
}

function appendRunLog(run: ActiveRun, entry: HistoryEntry) {
  ensureDir(dirname(run.logPath));
  const artifacts = entry.artifacts?.length ? `\nArtifacts:\n${entry.artifacts.map((a) => `- ${a}`).join("\n")}` : "";
  const lessons = entry.lessonsLearned?.length ? `\nLessons:\n${entry.lessonsLearned.map((l) => `- ${l}`).join("\n")}` : "";
  const stdout = entry.verifyStdout ? `\n\nStdout:\n\`\`\`\n${entry.verifyStdout}\n\`\`\`` : "";
  const stderr = entry.verifyStderr ? `\n\nStderr:\n\`\`\`\n${entry.verifyStderr}\n\`\`\`` : "";
  const step = entry.stepName ? ` — ${entry.stepName}` : "";
  appendFileSync(
    run.logPath,
    `\n## Iteration ${entry.iteration}.${entry.stepIteration}${step} — ${entry.status} — ${entry.timestamp}\n\n${entry.summary}\n\nVerification: ${entry.verification}${artifacts}${lessons}${stdout}${stderr}\n`,
    "utf8",
  );
}

function normalizeSpec(raw: unknown, fallbackName: string): LoopSpec {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopSpec> & {
    iterationPrompt?: string;
    doneRule?: string;
    verificationHint?: string;
    plan?: unknown[];
  };
  const name = sanitizeName(String(input.name || fallbackName));
  const fallback = {
    taskPrompt: String(input.taskPrompt || input.iterationPrompt || "Do one focused iteration toward the goal, then call loop_report."),
    verifyCommand: String(input.verifyCommand || input.verificationHint || "npm test"),
    doneWhen: String(input.doneWhen || input.doneRule || "verifyCommand exits 0"),
  };
  const plan = Array.isArray(input.plan) ? input.plan.map((step, index) => normalizeStep(step, index, fallback)) : [];
  const mode: LoopMode = input.mode === "dag-plan" ? "dag-plan" : input.mode === "test-plan" || plan.length > 0 ? "test-plan" : input.mode === "standard" ? "standard" : "tdd";
  const maxIterationsPerStep = Math.max(
    1,
    Math.min(MAX_SAFE_ITERATIONS, Number.isFinite(input.maxIterationsPerStep) ? Math.floor(Number(input.maxIterationsPerStep)) : DEFAULT_ITERATIONS_PER_STEP),
  );
  const defaultMaxIterations = mode === "test-plan" || mode === "dag-plan" ? Math.min(MAX_SAFE_ITERATIONS, Math.max(1, plan.length || 1) * maxIterationsPerStep + (input.finalVerifyCommand ? maxIterationsPerStep : 0)) : 5;
  const maxIterations = Math.max(
    1,
    Math.min(MAX_SAFE_ITERATIONS, Number.isFinite(input.maxIterations) ? Math.floor(Number(input.maxIterations)) : defaultMaxIterations),
  );
  const verifyTimeoutMs = Math.max(1_000, Number.isFinite(input.verifyTimeoutMs) ? Math.floor(Number(input.verifyTimeoutMs)) : DEFAULT_VERIFY_TIMEOUT_MS);
  const parallelism = Math.max(1, Math.min(MAX_SAFE_ITERATIONS, Number.isFinite(input.parallelism) ? Math.floor(Number(input.parallelism)) : 1));
  return {
    name,
    goal: String(input.goal || "Complete the requested task."),
    mode,
    taskPrompt: fallback.taskPrompt,
    verifyCommand: fallback.verifyCommand,
    doneWhen: fallback.doneWhen,
    maxIterations,
    maxIterationsPerStep,
    trainingMode: input.trainingMode !== false,
    verifyTimeoutMs,
    plan,
    parallelism,
    ...(input.finalVerifyCommand ? { finalVerifyCommand: String(input.finalVerifyCommand) } : {}),
    ...(input.memoryPath ? { memoryPath: String(input.memoryPath) } : {}),
  };
}

function defaultSpec(name: string): LoopSpec {
  const safeName = sanitizeName(name);
  return {
    name: safeName,
    goal: "Describe the concrete goal this loop should finish.",
    mode: "tdd",
    taskPrompt: "First write or update a failing test that proves the requested behavior. Then implement the smallest fix. End by calling loop_report.",
    verifyCommand: "npm test",
    doneWhen: "verifyCommand exits 0",
    maxIterations: 5,
    maxIterationsPerStep: DEFAULT_ITERATIONS_PER_STEP,
    trainingMode: true,
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    plan: [],
    parallelism: 1,
  };
}

function candidateSpecPaths(cwd: string, specArg: string) {
  const trimmed = specArg.trim();
  const withJson = trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
  if (isAbsolute(trimmed)) return [trimmed, withJson];
  if (trimmed.includes("/") || trimmed.includes("\\")) return [resolve(cwd, trimmed), resolve(cwd, withJson)];
  const name = sanitizeName(trimmed);
  return [
    join(projectLoopDir(cwd), "specs", `${name}.json`),
    join(projectLoopDir(cwd), `${name}.json`),
    join(GLOBAL_LOOP_DIR, "specs", `${name}.json`),
  ];
}

function loadSpec(cwd: string, specArg: string): { spec: LoopSpec; path: string } {
  const paths = candidateSpecPaths(cwd, specArg);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { spec: normalizeSpec(raw, specArg), path };
  }
  throw new Error(`Loop spec not found. Checked:\n${paths.map((p) => `- ${p}`).join("\n")}`);
}

function persistRun(run: ActiveRun) {
  run.updatedAt = nowStamp();
  writeJson(run.runPath, run);
}

function isLinearPlan(run: ActiveRun) {
  return run.spec.mode === "test-plan" && run.spec.plan.length > 0;
}

function isDagPlan(run: ActiveRun) {
  return run.spec.mode === "dag-plan" && run.spec.plan.length > 0;
}

function completedTaskSet(run: ActiveRun) {
  return new Set(run.completedTaskIds);
}

function readyDagSteps(run: ActiveRun) {
  if (!isDagPlan(run)) return [];
  const done = completedTaskSet(run);
  return run.spec.plan.filter((step) => !done.has(step.id) && step.dependsOn.every((dep) => done.has(dep))).slice(0, run.spec.parallelism);
}

function findStep(run: ActiveRun, id: string) {
  return run.spec.plan.find((step) => step.id === id);
}

function selectDagStep(run: ActiveRun, requestedTaskId?: string) {
  const ready = readyDagSteps(run);
  if (requestedTaskId) {
    const requested = ready.find((step) => step.id === sanitizeName(requestedTaskId));
    if (requested) return requested;
  }
  if (run.currentTaskId) {
    const current = ready.find((step) => step.id === run.currentTaskId);
    if (current) return current;
  }
  return ready[0];
}

function currentStep(run: ActiveRun): LoopStep {
  if (isLinearPlan(run)) return run.spec.plan[Math.min(run.currentStepIndex, run.spec.plan.length - 1)];
  if (isDagPlan(run)) {
    const selected = selectDagStep(run);
    if (selected) return selected;
    return run.spec.plan.find((step) => !completedTaskSet(run).has(step.id)) ?? run.spec.plan[run.spec.plan.length - 1];
  }
  return {
    id: "single-step",
    name: "single-step",
    taskPrompt: run.spec.taskPrompt,
    verifyCommand: run.spec.verifyCommand,
    doneWhen: run.spec.doneWhen,
    dependsOn: [],
  };
}

function currentStepLabel(run: ActiveRun) {
  if (isLinearPlan(run)) return `${run.currentStepIndex + 1}/${run.spec.plan.length}: ${currentStep(run).name}`;
  if (isDagPlan(run)) return `ready: ${currentStep(run).id} (${currentStep(run).name})`;
  return "single-step";
}

function formatHistory(run: ActiveRun) {
  if (run.history.length === 0) return "No previous iterations.";
  return run.history
    .map((entry) => {
      const next = entry.nextPrompt ? `\nNext hint: ${entry.nextPrompt}` : "";
      const step = entry.stepName ? ` [${entry.stepName}]` : "";
      return `Iteration ${entry.iteration}.${entry.stepIteration}${step} (${entry.status}): ${entry.summary}\nVerification: ${entry.verification}${next}`;
    })
    .join("\n\n");
}

function formatPlan(run: ActiveRun) {
  if (isLinearPlan(run)) {
    const lines = run.spec.plan.map((step, index) => {
      const marker = index < run.currentStepIndex ? "✓" : index === run.currentStepIndex ? "→" : "•";
      return `${marker} ${index + 1}. ${step.name} [${step.id}] — ${step.verifyCommand}`;
    });
    const final = run.spec.finalVerifyCommand ? [`Final verifier: ${run.spec.finalVerifyCommand}`] : [];
    return `\nTest plan:\n${[...lines, ...final].join("\n")}\n`;
  }
  if (isDagPlan(run)) {
    const done = completedTaskSet(run);
    const ready = new Set(readyDagSteps(run).map((step) => step.id));
    const lines = run.spec.plan.map((step) => {
      const marker = done.has(step.id) ? "✓" : ready.has(step.id) ? "→" : "•";
      const deps = step.dependsOn.length ? ` deps: ${step.dependsOn.join(",")}` : "";
      return `${marker} ${step.id}: ${step.name}${deps} — ${step.verifyCommand}`;
    });
    const final = run.spec.finalVerifyCommand ? [`Final verifier: ${run.spec.finalVerifyCommand}`] : [];
    return `\nDAG test plan (→ ready, ✓ done):\n${[...lines, ...final].join("\n")}\n`;
  }
  return "";
}

function buildIterationPrompt(run: ActiveRun, promptOverride?: string) {
  const step = currentStep(run);
  const prompt = promptOverride?.trim() || step.taskPrompt;
  const ready = isDagPlan(run) ? readyDagSteps(run) : [];
  const dagInstructions = isDagPlan(run)
    ? `\nDAG mode:\n- Independent ready tasks may be implemented in any safe order.\n- Work on exactly one ready task in this iteration. Suggested task: ${step.id}.\n- If you choose a different ready task, set loop_report.taskId to that task id.\n- Ready task ids: ${ready.map((s) => s.id).join(", ") || "none"}.\n`
    : "";
  const tdd = run.spec.mode === "tdd" || run.spec.mode === "test-plan" || run.spec.mode === "dag-plan"
    ? "\nTDD mode:\n- Codify the expected functionality into tests.\n- For this iteration, satisfy the current test-backed step only.\n- Completion verification is the authoritative test command passing.\n"
    : "";
  const plan = formatPlan(run);
  return `You are running Pi loop \"${run.spec.name}\".\n\nGoal:\n${run.spec.goal}\n\nCurrent step:\n${currentStepLabel(run)}\n\nDone when for current step:\n${step.doneWhen}\n\nAuthoritative verifier for current step:\n${step.verifyCommand}\n\nTotal iteration ${run.iteration} of ${run.spec.maxIterations}. Step iteration ${run.stepIteration} of ${run.spec.maxIterationsPerStep}.\n${plan}${dagInstructions}${tdd}\nPrevious loop history:\n${formatHistory(run)}\n\nThis iteration prompt:\n${prompt}\n\nLoop protocol:\n- Do one focused iteration only.\n- Use available execution skills/tools as needed.\n- You may run checks while working, but final step completion is decided by the extension running the authoritative verifier after your report.\n- End by calling loop_report exactly once.\n- Set blocked=true only if progress requires human input, missing access, ambiguity, or an unsafe action.\n- If not blocked, include nextPrompt only when you have a useful hint for a possible next iteration.\n- In test-plan mode, the extension advances to the next test step only after the current step verifier passes.\n- In dag-plan mode, the extension marks the reported ready task done after its verifier passes and unlocks dependent tasks.`;
}

function statusText(run?: ActiveRun) {
  if (!run) return "loop: idle";
  return `loop: ${run.spec.name} ${run.status} total ${run.iteration}/${run.spec.maxIterations}, step ${currentStepLabel(run)} ${run.stepIteration}/${run.spec.maxIterationsPerStep}`;
}

function updateUi(ctx: { ui?: { setStatus?: (key: string, value?: string) => void; setWidget?: (key: string, value?: string[] | undefined) => void } }, run?: ActiveRun) {
  ctx.ui?.setStatus?.("pi-loop", run ? statusText(run) : undefined);
  if (!run) {
    ctx.ui?.setWidget?.("pi-loop", undefined);
    return;
  }
  const step = currentStep(run);
  const last = run.history.at(-1);
  ctx.ui?.setWidget?.("pi-loop", [
    `↻ Loop: ${run.spec.name} (${run.status}, ${currentStepLabel(run)})`,
    `Verifier: ${step.verifyCommand}`,
    last ? `Last: ${last.status} — ${last.verification}` : "Last: not started",
  ]);
}

function startRun(cwd: string, spec: LoopSpec, specPath: string): ActiveRun {
  const startedAt = nowStamp();
  const runId = `${sanitizeName(spec.name)}-${fileStamp()}`;
  const baseRunDir = spec.memoryPath ? resolve(cwd, spec.memoryPath) : join(projectLoopDir(cwd), "runs", sanitizeName(spec.name));
  const runPath = join(baseRunDir, `${runId}.json`);
  const logPath = join(baseRunDir, `${runId}.md`);
  const firstTaskId = spec.mode === "dag-plan" ? spec.plan.find((step) => step.dependsOn.length === 0)?.id : undefined;
  const run: ActiveRun = {
    runId,
    cwd,
    specPath,
    runPath,
    logPath,
    spec,
    iteration: 1,
    stepIteration: 1,
    currentStepIndex: 0,
    currentTaskId: firstTaskId,
    completedTaskIds: [],
    status: "running",
    startedAt,
    updatedAt: startedAt,
    history: [],
  };
  const step = currentStep(run);
  writeJson(runPath, run);
  appendFileSync(
    logPath,
    `# Loop run: ${spec.name}\n\n- Run ID: ${runId}\n- Started: ${startedAt}\n- Goal: ${spec.goal}\n- Mode: ${spec.mode}\n- Current step: ${currentStepLabel(run)}\n- Done when: ${step.doneWhen}\n- Verifier: ${step.verifyCommand}\n- Parallelism: ${spec.parallelism}\n- Final verifier: ${spec.finalVerifyCommand || "none"}\n- Spec: ${specPath}\n`,
    "utf8",
  );
  return run;
}

export default function piLoop(pi: ExtensionAPI) {
  let activeRun: ActiveRun | undefined;

  pi.on("resources_discover", async () => ({
    skillPaths: [join(dirname(__filename), "skills")],
  }));

  async function queueNext(run: ActiveRun, prompt?: string) {
    const message = buildIterationPrompt(run, prompt);
    if (pi.getSessionName?.() === undefined) pi.setSessionName?.(`Loop: ${run.spec.name}`);
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch {
      pi.sendUserMessage(message);
    }
  }

  async function runVerifier(run: ActiveRun, signal: AbortSignal | undefined, command = currentStep(run).verifyCommand) {
    const shellCommand = `cd ${shellQuote(run.cwd)} && ${command}`;
    const result = await pi.exec("bash", ["-lc", shellCommand], { signal, timeout: run.spec.verifyTimeoutMs } as any) as any;
    const exitCode = typeof result.code === "number" ? result.code : null;
    const stdout = trunc(result.stdout);
    const stderr = trunc(result.stderr);
    const verification = `\`${command}\` exited ${exitCode}${result.killed ? " (killed/timeout)" : ""}`;
    return { command, exitCode, stdout, stderr, verification };
  }

  function makeEntry(run: ActiveRun, report: LoopReport, status: LoopStatus, verification: Awaited<ReturnType<typeof runVerifier>>, step = currentStep(run)): HistoryEntry {
    return {
      ...report,
      iteration: run.iteration,
      stepIteration: run.stepIteration,
      stepIndex: isLinearPlan(run) ? run.currentStepIndex : undefined,
      stepId: step.id,
      stepName: step.name,
      timestamp: nowStamp(),
      status,
      verification: verification.verification,
      verifyCommand: verification.command,
      verifyExitCode: verification.exitCode,
      verifyStdout: verification.stdout,
      verifyStderr: verification.stderr,
    };
  }

  function stopRun(ctx: any, status: RunStatus, message: string, details: Record<string, unknown>) {
    if (!activeRun) return { content: [{ type: "text", text: message }], details, terminate: true };
    activeRun.status = status;
    persistRun(activeRun);
    updateUi(ctx, activeRun);
    const runPath = activeRun.runPath;
    activeRun = undefined;
    updateUi(ctx, undefined);
    return {
      content: [{ type: "text", text: `${message} Run saved to ${runPath}` }],
      details: { ...details, runPath },
      terminate: true,
    };
  }

  async function maybeConfirmContinue(ctx: any, title: string, body: string) {
    if (!activeRun?.spec.trainingMode || !ctx.hasUI) return true;
    return await ctx.ui.confirm(title, body);
  }

  async function handleNew(args: string, ctx: any) {
    let name = sanitizeName(args || "");
    if (!name && ctx.hasUI) {
      const answer = await ctx.ui.input("Loop name", "dev-infra-check");
      name = sanitizeName(answer || "");
    }
    if (!name) {
      ctx.ui.notify("Usage: /loop:new <name>", "warning");
      return;
    }

    const specPath = join(projectLoopDir(ctx.cwd), "specs", `${name}.json`);
    if (existsSync(specPath)) {
      ctx.ui.notify(`Loop spec already exists: ${specPath}`, "warning");
      return;
    }

    let specText = `${JSON.stringify(defaultSpec(name), null, 2)}\n`;
    if (ctx.hasUI) {
      const edited = await ctx.ui.editor("Edit deterministic loop spec JSON", specText);
      if (!edited) {
        ctx.ui.notify("Loop spec creation cancelled", "warning");
        return;
      }
      specText = edited;
    }

    const parsed = normalizeSpec(JSON.parse(specText), name);
    writeJson(specPath, parsed);
    ctx.ui.notify(`Created loop spec: ${specPath}`, "info");
  }

  async function handleRun(args: string, ctx: any) {
    const specArg = args.trim();
    if (!specArg) {
      ctx.ui.notify("Usage: /loop:run <name-or-path>", "warning");
      return;
    }
    if (activeRun?.status === "running") {
      ctx.ui.notify(`A loop is already running: ${activeRun.spec.name}. Use /loop:stop first.`, "warning");
      return;
    }
    const { spec, path } = loadSpec(ctx.cwd, specArg);
    if ((spec.mode === "test-plan" || spec.mode === "dag-plan") && spec.plan.length === 0) {
      ctx.ui.notify(`${spec.mode} specs need a non-empty plan array.`, "warning");
      return;
    }
    if (spec.mode === "dag-plan" && spec.plan.length > 0 && !spec.plan.some((step) => step.dependsOn.length === 0)) {
      ctx.ui.notify("dag-plan specs need at least one task with no dependsOn.", "warning");
      return;
    }
    if (!spec.verifyCommand.trim() && spec.plan.length === 0) {
      ctx.ui.notify("Loop spec needs a non-empty verifyCommand.", "warning");
      return;
    }
    activeRun = startRun(ctx.cwd, spec, path);
    updateUi(ctx, activeRun);
    ctx.ui.notify(`Started loop ${spec.name} (${activeRun.runId})`, "info");
    await queueNext(activeRun, currentStep(activeRun).taskPrompt);
  }

  async function handleStatus(_args: string, ctx: any) {
    if (!activeRun) {
      ctx.ui.notify("No active loop.", "info");
      return;
    }
    updateUi(ctx, activeRun);
    const last = activeRun.history.at(-1);
    ctx.ui.notify(
      `${statusText(activeRun)}\nRun file: ${activeRun.runPath}\nVerifier: ${currentStep(activeRun).verifyCommand}\n${last ? `Last report: ${last.status} — ${last.verification}` : "No reports yet."}`,
      "info",
    );
  }

  async function handleStop(_args: string, ctx: any) {
    if (!activeRun) {
      ctx.ui.notify("No active loop to stop.", "info");
      return;
    }
    activeRun.status = "stopped";
    persistRun(activeRun);
    ctx.ui.notify(`Stopped loop ${activeRun.spec.name}. Run file: ${activeRun.runPath}`, "info");
    activeRun = undefined;
    updateUi(ctx, undefined);
  }

  function registerLoopAlias(name: string, handler: (args: string, ctx: any) => Promise<void>) {
    pi.registerCommand(name, {
      description: `Pi loop command: ${name}`,
      handler: async (args, ctx) => {
        try {
          await handler(args, ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }

  pi.registerCommand("loop", {
    description: "Loop engineering orchestrator. Usage: /loop new|run|status|stop ...",
    handler: async (args, ctx) => {
      const [subcommandRaw, ...rest] = args.trim().split(/\s+/);
      const subcommand = (subcommandRaw || "status").toLowerCase();
      const subArgs = rest.join(" ");
      try {
        if (subcommand === "new") return await handleNew(subArgs, ctx);
        if (subcommand === "run") return await handleRun(subArgs, ctx);
        if (subcommand === "status") return await handleStatus(subArgs, ctx);
        if (subcommand === "stop") return await handleStop(subArgs, ctx);
        ctx.ui.notify("Usage: /loop new|run|status|stop ...", "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  registerLoopAlias("loop:new", handleNew);
  registerLoopAlias("loop:run", handleRun);
  registerLoopAlias("loop:status", handleStatus);
  registerLoopAlias("loop:stop", handleStop);

  pi.registerTool({
    name: "loop_report",
    label: "Loop Report",
    description: "Report one loop iteration to the Pi loop orchestrator. The extension then runs the current step verifier and decides progress deterministically.",
    promptSnippet: "Report loop iteration progress; pi-loop runs the current verifier to decide completion",
    promptGuidelines: [
      "Use loop_report exactly once at the end of a Pi loop iteration when a /loop:run prompt asks for it.",
      "Do not claim loop completion in loop_report; pi-loop decides completion by running the current verifyCommand.",
      "Set loop_report blocked=true only when progress requires human input, missing access, ambiguity, or an unsafe action.",
    ],
    parameters: LoopReportSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!activeRun || activeRun.status !== "running") {
        return {
          content: [{ type: "text", text: "No active loop run is waiting for a report." }],
          details: { accepted: false },
          terminate: true,
        };
      }

      const report = params as LoopReport;
      const requestedTaskId = report.taskId ? sanitizeName(report.taskId) : undefined;
      const step = isDagPlan(activeRun) ? selectDagStep(activeRun, requestedTaskId) : currentStep(activeRun);
      if (!step) {
        return stopRun(ctx, "blocked", "Loop blocked: no ready DAG task is available.", { accepted: true, finalStatus: "blocked" });
      }
      if (isDagPlan(activeRun)) activeRun.currentTaskId = step.id;

      if (report.blocked) {
        const entry: HistoryEntry = {
          ...report,
          iteration: activeRun.iteration,
          stepIteration: activeRun.stepIteration,
          stepIndex: isLinearPlan(activeRun) ? activeRun.currentStepIndex : undefined,
          stepId: step.id,
          stepName: step.name,
          timestamp: nowStamp(),
          status: "blocked",
          verification: "Agent reported blocked before verifier could decide completion.",
        };
        activeRun.history.push(entry);
        appendRunLog(activeRun, entry);
        return stopRun(ctx, "blocked", "Loop blocked.", { accepted: true, finalStatus: "blocked" });
      }

      const verification = await runVerifier(activeRun, signal, step.verifyCommand);
      const status: LoopStatus = verification.exitCode === 0 ? "done" : "not_done";
      const entry = makeEntry(activeRun, report, status, verification, step);
      activeRun.history.push(entry);
      appendRunLog(activeRun, entry);

      if (status === "done" && isDagPlan(activeRun)) {
        if (!activeRun.completedTaskIds.includes(step.id)) activeRun.completedTaskIds.push(step.id);
        activeRun.currentTaskId = selectDagStep(activeRun)?.id;
        if (activeRun.completedTaskIds.length < activeRun.spec.plan.length) {
          activeRun.iteration += 1;
          activeRun.stepIteration = 1;
          persistRun(activeRun);
          updateUi(ctx, activeRun);
          const nextStep = currentStep(activeRun);
          const ok = await maybeConfirmContinue(
            ctx,
            `Continue loop ${activeRun.spec.name}?`,
            `Completed DAG task ${step.id}.\n\nNext ready task: ${currentStepLabel(activeRun)}\nVerifier: ${nextStep.verifyCommand}`,
          );
          if (!ok) return stopRun(ctx, "stopped", "Loop paused by user.", { accepted: true, finalStatus: "stopped", verification });
          await queueNext(activeRun, nextStep.taskPrompt);
          return {
            content: [{ type: "text", text: `DAG task verifier passed; queued ready task ${currentStepLabel(activeRun)}.` }],
            details: { accepted: true, finalStatus: "running", runPath: activeRun.runPath, nextIteration: activeRun.iteration, completedTaskIds: activeRun.completedTaskIds, verification },
            terminate: true,
          };
        }
      }

      if (status === "done" && isLinearPlan(activeRun) && activeRun.currentStepIndex < activeRun.spec.plan.length - 1) {
        const completedStep = currentStepLabel(activeRun);
        activeRun.currentStepIndex += 1;
        activeRun.iteration += 1;
        activeRun.stepIteration = 1;
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const nextStep = currentStep(activeRun);
        const ok = await maybeConfirmContinue(
          ctx,
          `Continue loop ${activeRun.spec.name}?`,
          `Completed ${completedStep}.\n\nNext step: ${currentStepLabel(activeRun)}\nVerifier: ${nextStep.verifyCommand}`,
        );
        if (!ok) return stopRun(ctx, "stopped", "Loop paused by user.", { accepted: true, finalStatus: "stopped", verification });
        await queueNext(activeRun, nextStep.taskPrompt);
        return {
          content: [{ type: "text", text: `Step verifier passed; queued next test step ${currentStepLabel(activeRun)}.` }],
          details: { accepted: true, finalStatus: "running", runPath: activeRun.runPath, nextIteration: activeRun.iteration, verification },
          terminate: true,
        };
      }

      if (status === "done" && activeRun.spec.finalVerifyCommand) {
        const finalVerification = await runVerifier(activeRun, signal, activeRun.spec.finalVerifyCommand);
        const finalStatus: LoopStatus = finalVerification.exitCode === 0 ? "done" : "not_done";
        const finalEntry = makeEntry(activeRun, { ...report, summary: `Final verifier after: ${report.summary}` }, finalStatus, finalVerification, {
          id: "final-verifier",
          name: "final-verifier",
          taskPrompt: "Final verification",
          verifyCommand: activeRun.spec.finalVerifyCommand,
          doneWhen: "finalVerifyCommand exits 0",
          dependsOn: [],
        });
        activeRun.history.push(finalEntry);
        appendRunLog(activeRun, finalEntry);
        if (finalStatus === "done") {
          return stopRun(ctx, "done", "Loop complete: final verifier passed.", { accepted: true, finalStatus: "done", verification: finalVerification });
        }
        if (activeRun.iteration >= activeRun.spec.maxIterations || activeRun.stepIteration >= activeRun.spec.maxIterationsPerStep) {
          return stopRun(ctx, "max_iterations", "Loop stopped at maxIterations: final verifier still fails.", { accepted: true, finalStatus: "max_iterations", verification: finalVerification });
        }
        activeRun.iteration += 1;
        activeRun.stepIteration += 1;
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const finalPrompt = report.nextPrompt?.trim() || `All planned step tests passed, but the final verifier failed: ${activeRun.spec.finalVerifyCommand}. Fix integration/regression failures while preserving the passing step tests, then call loop_report.`;
        const ok = await maybeConfirmContinue(
          ctx,
          `Continue loop ${activeRun.spec.name}?`,
          `Final verifier failed: ${finalVerification.verification}\n\nNext iteration: ${activeRun.iteration}/${activeRun.spec.maxIterations}`,
        );
        if (!ok) return stopRun(ctx, "stopped", "Loop paused by user.", { accepted: true, finalStatus: "stopped", verification: finalVerification });
        await queueNext(activeRun, finalPrompt);
        return {
          content: [{ type: "text", text: `Final verifier failed; queued loop iteration ${activeRun.iteration}/${activeRun.spec.maxIterations}.` }],
          details: { accepted: true, finalStatus: "running", runPath: activeRun.runPath, nextIteration: activeRun.iteration, verification: finalVerification },
          terminate: true,
        };
      }

      if (status === "done") {
        return stopRun(ctx, "done", "Loop complete: verifier passed.", { accepted: true, finalStatus: "done", verification });
      }

      if (activeRun.iteration >= activeRun.spec.maxIterations || activeRun.stepIteration >= activeRun.spec.maxIterationsPerStep) {
        return stopRun(ctx, "max_iterations", "Loop stopped at maxIterations: verifier still fails.", { accepted: true, finalStatus: "max_iterations", verification });
      }

      const nextPrompt = report.nextPrompt?.trim() || step.taskPrompt;
      activeRun.iteration += 1;
      activeRun.stepIteration += 1;
      persistRun(activeRun);
      updateUi(ctx, activeRun);

      const ok = await maybeConfirmContinue(
        ctx,
        `Continue loop ${activeRun.spec.name}?`,
        `Next iteration: ${activeRun.iteration}/${activeRun.spec.maxIterations}\nStep iteration: ${activeRun.stepIteration}/${activeRun.spec.maxIterationsPerStep}\n\nVerifier failed: ${verification.verification}\n\nLast summary: ${report.summary}`,
      );
      if (!ok) return stopRun(ctx, "stopped", "Loop paused by user.", { accepted: true, finalStatus: "stopped", verification });

      await queueNext(activeRun, nextPrompt);
      return {
        content: [{ type: "text", text: `Verifier failed; queued loop iteration ${activeRun.iteration}/${activeRun.spec.maxIterations}.` }],
        details: { accepted: true, finalStatus: "running", runPath: activeRun.runPath, nextIteration: activeRun.iteration, verification },
        terminate: true,
      };
    },
  });
}
