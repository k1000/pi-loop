import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const LOOP_CONFIG_DIR = ".pi";
const GLOBAL_LOOP_DIR = join(homedir(), ".pi", "agent", "loops");
const MAX_SAFE_ITERATIONS = 50;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const DEFAULT_ITERATIONS_PER_STEP = 3;

const TDD_QUALITY_CONTRACT = `
TDD test-quality contract:
- Before coding, identify the behavior slice under test and the likely failure modes for this slice: happy path, boundary/empty/invalid input, regression/predictable failure, and ordering/idempotency/concurrency/persistence/permission risks when relevant.
- Write or update ONE focused behavior test through the public interface. Prefer observable behavior over implementation shape, private methods, or mock choreography.
- Red phase: run the targeted test before implementation when practical and confirm it fails for the expected reason. If it passes immediately, adjust it or explain why existing coverage already proves the behavior.
- Green phase: implement the smallest fix for this behavior only. Do not add speculative behavior for future tests.
- Before reporting, check that the test would fail against the old/broken behavior and mention any relevant edge cases intentionally deferred.
`;

type LoopStatus = "done" | "not_done" | "blocked";
type RunStatus = "running" | "done" | "blocked" | "stopped" | "max_iterations";
type LoopMode = "tdd" | "test-plan" | "dag-plan";

type LoopStep = {
  id: string;
  name: string;
  taskPrompt: string;
  verifyCommand: string;
  dependsOn: string[];
};

type LoopSpec = {
  name: string;
  goal: string;
  mode: LoopMode;
  taskPrompt: string;
  verifyCommand: string;
  maxIterations: number;
  maxIterationsPerStep: number;
  memoryPath?: string;
  verifyTimeoutMs: number;
  verifyOutputPattern?: string;
  verifyPrefix?: string;
  plan: LoopStep[];
  finalVerifyCommand?: string;
  parallelism: number;
  autoCommitEachStep: boolean;
  autoCommitNoVerify: boolean;
  autoCommitAddUntracked: boolean;
  specVersion: number;
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
  finalVerifierAttempts: number;
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
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

function trunc(text: unknown, max = 4000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const STEP_KNOWN_KEYS = new Set(["id", "name", "taskPrompt", "verifyCommand", "dependsOn"]);
const SPEC_KNOWN_KEYS = new Set([
  "name", "goal", "mode", "taskPrompt", "verifyCommand", "maxIterations",
  "maxIterationsPerStep", "memoryPath", "verifyTimeoutMs", "verifyOutputPattern",
  "verifyPrefix", "plan", "finalVerifyCommand", "parallelism", "autoCommitEachStep",
  "autoCommitNoVerify", "autoCommitAddUntracked",
  // legacy compat aliases
  "iterationPrompt", "doneRule", "verificationHint",
]);

function warnUnknownFields(raw: unknown, known: Set<string>, label: string) {
  if (!raw || typeof raw !== "object") return;
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      console.warn(`tdd_loop: unknown field "${key}" in ${label} — it will be ignored.`);
    }
  }
}

function normalizeStep(raw: unknown, index: number, fallback: Pick<LoopStep, "taskPrompt" | "verifyCommand">): LoopStep {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopStep>;
  warnUnknownFields(raw, STEP_KNOWN_KEYS, `plan step ${index + 1}`);
  const name = String(input.name || `step-${index + 1}`);
  const id = sanitizeName(String(input.id || name || `step-${index + 1}`));
  const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map((dep) => sanitizeName(String(dep))).filter(Boolean) : [];
  return {
    id,
    name,
    taskPrompt: String(input.taskPrompt || fallback.taskPrompt),
    verifyCommand: String(input.verifyCommand || fallback.verifyCommand),
    dependsOn,
  };
}

function detectCycles(steps: LoopStep[]): string | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const step of steps) adj.set(step.id, step.dependsOn);

  function dfs(node: string, path: string[]): string | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node].join(" → ");
    }
    if (visited.has(node)) return null;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const dep of adj.get(node) || []) {
      const result = dfs(dep, path);
      if (result) return result;
    }
    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const step of steps) {
    const cycle = dfs(step.id, []);
    if (cycle) return cycle;
  }
  return null;
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
  warnUnknownFields(raw, SPEC_KNOWN_KEYS, "loop spec");
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopSpec> & {
    iterationPrompt?: string;
    doneRule?: string;
    verificationHint?: string;
    plan?: unknown[];
  };
  const name = sanitizeName(String(input.name || fallbackName));
  const fallback = {
    taskPrompt: String(input.taskPrompt || input.iterationPrompt || "Do one focused iteration toward the goal, then call tdd_loop_report."),
    verifyCommand: String(input.verifyCommand || input.verificationHint || "npm test"),
  };
  const plan = Array.isArray(input.plan) ? input.plan.map((step, index) => normalizeStep(step, index, fallback)) : [];
  const mode: LoopMode = input.mode === "dag-plan" ? "dag-plan" : input.mode === "test-plan" || plan.length > 0 ? "test-plan" : "tdd";
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
  const autoCommitEachStep = input.autoCommitEachStep !== false;
  return {
    name,
    goal: String(input.goal || "Complete the requested task."),
    mode,
    taskPrompt: fallback.taskPrompt,
    verifyCommand: fallback.verifyCommand,
    maxIterations,
    maxIterationsPerStep,
    verifyTimeoutMs,
    verifyOutputPattern: input.verifyOutputPattern ? String(input.verifyOutputPattern) : undefined,
    verifyPrefix: input.verifyPrefix ? String(input.verifyPrefix) : undefined,
    plan,
    parallelism,
    autoCommitEachStep,
    autoCommitNoVerify: input.autoCommitNoVerify !== false,
    autoCommitAddUntracked: input.autoCommitAddUntracked === true,
    specVersion: 1,
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
    taskPrompt: "First write or update one behavior-focused failing test that proves the requested behavior and its predictable failure mode. Then implement the smallest fix. End by calling tdd_loop_report.",
    verifyCommand: "npm test",
    maxIterations: 5,
    maxIterationsPerStep: DEFAULT_ITERATIONS_PER_STEP,
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    plan: [],
    parallelism: 1,
    autoCommitEachStep: true,
    autoCommitNoVerify: false,
    autoCommitAddUntracked: false,
    specVersion: 1,
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

function mutateAndPersist(run: ActiveRun, mutator: (snapshot: ActiveRun) => void) {
  const snapshot: ActiveRun = JSON.parse(JSON.stringify(run));
  mutator(snapshot);
  snapshot.updatedAt = nowStamp();
  writeJson(run.runPath, snapshot);
  mutator(run);
  run.updatedAt = snapshot.updatedAt;
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

function selectDagStep(run: ActiveRun, requestedTaskId?: string) {
  const done = completedTaskSet(run);
  if (requestedTaskId && done.has(sanitizeName(requestedTaskId))) return undefined;
  const ready = readyDagSteps(run);
  if (requestedTaskId) {
    const requested = ready.find((step) => step.id === sanitizeName(requestedTaskId));
    if (requested) return requested;
  }
  if (run.currentTaskId && !done.has(run.currentTaskId)) {
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
  const MAX_DISPLAY = 10;
  const entries = run.history;
  const skipped = entries.length > MAX_DISPLAY ? entries.length - MAX_DISPLAY : 0;
  const display = skipped > 0 ? entries.slice(skipped) : entries;
  const prefix = skipped > 0 ? `[${skipped} earlier entries omitted; see run log for full history]\n\n` : "";
  return prefix + display
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
    ? `\nDAG mode:\n- Independent ready tasks may be implemented in any safe order.\n- Work on exactly one ready task in this iteration. Suggested task: ${step.id}.\n- If you choose a different ready task, set tdd_loop_report.taskId to that task id.\n- Ready task ids: ${ready.map((s) => s.id).join(", ") || "none"}.\n`
    : "";
  const tdd = run.spec.mode === "tdd" || run.spec.mode === "test-plan" || run.spec.mode === "dag-plan"
    ? `\nTDD mode:\n- Codify the expected functionality into tests.\n- For this iteration, satisfy the current test-backed step only.\n- Completion verification is the authoritative test command passing.\n${TDD_QUALITY_CONTRACT}`
    : "";
  const plan = formatPlan(run);
  return `You are running Pi loop \"${run.spec.name}\".\n\nGoal:\n${run.spec.goal}\n\nCurrent step:\n${currentStepLabel(run)}\n\nAuthoritative verifier for current step:\n${step.verifyCommand}\n\nAttempt ${run.iteration} of ${run.spec.maxIterations}. Step attempt ${run.stepIteration} of ${run.spec.maxIterationsPerStep}.\n${plan}${dagInstructions}${tdd}\nPrevious loop history:\n${formatHistory(run)}\n\nThis iteration prompt:\n${prompt}\n\nLoop protocol:\n- Do one focused iteration only.\n- Use available execution skills/tools as needed.\n- You may run checks while working, but final step completion is decided by the extension running the authoritative verifier after your report.\n- End by calling tdd_loop_report exactly once.\n- Set blocked=true only if progress requires human input, missing access, ambiguity, or an unsafe action.\n- If not blocked, include nextPrompt only when you have a useful hint for a possible next iteration.\n- In test-plan mode, the extension advances to the next test step only after the current step verifier passes.\n- In dag-plan mode, the extension marks the reported ready task done after its verifier passes and unlocks dependent tasks.
- By default, the extension creates a local git commit after each completed step when there are working-tree changes. Set autoCommitEachStep=false in the loop spec to opt out.`;
}

function statusText(run?: ActiveRun) {
  if (!run) return "loop: idle";
  return `loop: ${run.spec.name} ${run.status} total ${run.iteration}/${run.spec.maxIterations}, step ${currentStepLabel(run)} ${run.stepIteration}/${run.spec.maxIterationsPerStep}`;
}

function updateUi(ctx: { ui?: { setStatus?: (key: string, value?: string) => void; setWidget?: (key: string, value?: string[] | undefined) => void } }, run?: ActiveRun) {
  ctx.ui?.setStatus?.("tdd_loop", run ? statusText(run) : undefined);
  if (!run) {
    ctx.ui?.setWidget?.("tdd_loop", undefined);
    return;
  }
  const step = currentStep(run);
  const last = run.history.at(-1);
  ctx.ui?.setWidget?.("tdd_loop", [
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
    finalVerifierAttempts: 0,
  };
  const step = currentStep(run);
  writeJson(runPath, run);
  appendFileSync(
    logPath,
    `# Loop run: ${spec.name}\n\n- Run ID: ${runId}\n- Started: ${startedAt}\n- Goal: ${spec.goal}\n- Mode: ${spec.mode}\n- Current step: ${currentStepLabel(run)}\n- Verifier: ${step.verifyCommand}\n- Parallelism: ${spec.parallelism}\n- Final verifier: ${spec.finalVerifyCommand || "none"}\n- Spec: ${specPath}\n`,
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
      try {
        pi.sendUserMessage(message);
      } catch (e) {
        console.error(`tdd_loop: failed to deliver iteration prompt for ${run.spec.name}:`, e);
      }
    }
  }

  async function runVerifier(run: ActiveRun, signal: AbortSignal | undefined, command = currentStep(run).verifyCommand) {
    const shellCommand = `cd ${shellQuote(run.cwd)} && ${command}`;
    const result: { code?: number; stdout?: string; stderr?: string; killed?: boolean } = await pi.exec("bash", ["-lc", shellCommand], { signal, timeout: run.spec.verifyTimeoutMs });
    let exitCode = typeof result.code === "number" ? result.code : null;
    const fullStdout = result.stdout || "";
    const fullStderr = result.stderr || "";
    const stdout = trunc(fullStdout);
    const stderr = trunc(fullStderr);
    const pattern = run.spec.verifyOutputPattern;
    if (exitCode === 0 && pattern) {
      if (!new RegExp(pattern, "m").test(fullStdout + "\n" + fullStderr)) {
        exitCode = 1;
      }
    }
    const patternSuffix = pattern && exitCode !== 0 ? ` (pattern /${pattern}/ not matched)` : "";
    const verification = `\`${command}\` exited ${exitCode}${result.killed ? " (killed/timeout)" : ""}${patternSuffix}`;
    return { command, exitCode, stdout, stderr, verification };
  }

  async function autoCommitStep(run: ActiveRun, signal: AbortSignal | undefined, entry: HistoryEntry) {
    if (!run.spec.autoCommitEachStep) return;
    if (entry.status !== "done") return;
    const stepName = entry.stepId ? `${entry.stepId}` : entry.stepName || "step";
    const message = `tdd-loop(${run.spec.name}): step ${stepName} passed`;
    const command = [
      "if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo 'Not inside a git work tree; skipping tdd-loop auto-commit.'; exit 0; fi",
      "if [ -z \"$(git status --porcelain)\" ]; then echo 'No changes to commit.'; exit 0; fi",
      run.spec.autoCommitAddUntracked ? "git add -A" : "git add -u",
      run.spec.autoCommitNoVerify ? `git commit --no-verify -m ${shellQuote(message)}` : `git commit -m ${shellQuote(message)}`,
    ].join(" && ");
    const shellCommand = `cd ${shellQuote(run.cwd)} && ${command}`;
    await pi.exec("bash", ["-lc", shellCommand], { signal, timeout: run.spec.verifyTimeoutMs });
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
    mutateAndPersist(activeRun, (r) => { r.status = status; });
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

  async function handleNew(args: string, ctx: any) {
    let name = sanitizeName(args || "");
    if (!name && ctx.hasUI) {
      const answer = await ctx.ui.input("Loop name", "dev-infra-check");
      name = sanitizeName(answer || "");
    }
    if (!name) {
      ctx.ui.notify("Usage: /tdd_loop:new <name>", "warning");
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
      ctx.ui.notify("Usage: /tdd_loop:run <name-or-path>", "warning");
      return;
    }
    if (activeRun?.status === "running") {
      ctx.ui.notify(`A loop is already running: ${activeRun.spec.name}. Use /tdd_loop:stop first.`, "warning");
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
    if ((spec.mode === "dag-plan" || spec.mode === "test-plan") && spec.plan.length > 0) {
      const cycle = detectCycles(spec.plan);
      if (cycle) {
        ctx.ui.notify(`Cycle detected in plan dependencies: ${cycle}. Fix the cycle before running.`, "error");
        return;
      }
    }
    if (spec.mode !== "dag-plan" && spec.mode !== "test-plan" && spec.plan.length > 0) {
      ctx.ui.notify(`Spec mode is "${spec.mode}" but plan has ${spec.plan.length} step(s). The plan will be ignored in single-step mode. Set mode to "test-plan" or "dag-plan" to use the plan.`, "warning");
    }
    if (!spec.verifyCommand.trim() && spec.plan.length === 0) {
      ctx.ui.notify("Loop spec needs a non-empty verifyCommand.", "warning");
      return;
    }
    // Validate verifyPrefix if set
    if (spec.verifyPrefix && !spec.verifyCommand.trim().startsWith(spec.verifyPrefix)) {
      ctx.ui.notify(`verifyCommand "${spec.verifyCommand}" does not match required prefix "${spec.verifyPrefix}".`, "warning");
      return;
    }
    // Block obviously dangerous commands
    const DANGEROUS_PATTERN = /(^|\s)(rm\s+-rf|dd\s+|:>\/|>:|mkfs|fdisk|format|chmod\s+777|sudo\s+)/;
    if (DANGEROUS_PATTERN.test(spec.verifyCommand) || (spec.finalVerifyCommand && DANGEROUS_PATTERN.test(spec.finalVerifyCommand))) {
      ctx.ui.notify("Loop spec contains a potentially dangerous command. If intentional, remove this check from index.ts.", "error");
      return;
    }
    // Claim the run slot synchronously to prevent TOCTOU race against concurrent commands
    activeRun = startRun(ctx.cwd, spec, path);
    updateUi(ctx, activeRun);
    ctx.ui.notify(`Started loop ${spec.name} (${activeRun.runId})`, "info");
    // Non-blocking dirty-tree warning (safe after run is claimed)
    try {
      const gitResult = await pi.exec("bash", ["-lc", `cd ${shellQuote(ctx.cwd)} && git status --porcelain`], { timeout: 5_000 });
      const dirty = (gitResult.stdout || "").trim();
      if (dirty) {
        const fileCount = dirty.split("\n").length;
        ctx.ui.notify(`Working tree has ${fileCount} pre-existing change(s). Auto-commit will include these if a step passes. Consider committing or stashing first.`, "warning");
      }
    } catch { /* not a git repo — skip check */ }
    await queueNext(activeRun, currentStep(activeRun).taskPrompt);
  }

  async function handleStop(_args: string, ctx: any) {
    if (!activeRun) {
      ctx.ui.notify("No active loop to stop.", "info");
      return;
    }
    mutateAndPersist(activeRun, (r) => { r.status = "stopped"; });
    ctx.ui.notify(`Stopped loop ${activeRun.spec.name}. Run file: ${activeRun.runPath}`, "info");
    activeRun = undefined;
    updateUi(ctx, undefined);
  }

  function findCandidateRunPaths(cwd: string, runArg: string): string[] {
    const trimmed = runArg.trim();
    const withJson = trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
    if (isAbsolute(trimmed)) return [trimmed, withJson];
    if (trimmed.includes("/") || trimmed.includes("\\")) return [resolve(cwd, trimmed), resolve(cwd, withJson)];
    const name = sanitizeName(trimmed);
    return [join(projectLoopDir(cwd), "runs", name, withJson)];
  }

  async function handleResume(args: string, ctx: any) {
    const runArg = args.trim();
    if (!runArg) {
      ctx.ui.notify("Usage: /tdd_loop:resume <run-path-or-name>", "warning");
      return;
    }
    if (activeRun?.status === "running") {
      ctx.ui.notify(`A loop is already running: ${activeRun.spec.name}. Use /tdd_loop:stop first.`, "warning");
      return;
    }

    const paths = findCandidateRunPaths(ctx.cwd, runArg);
    let loadPath: string | null = null;
    for (const p of paths) {
      if (existsSync(p)) { loadPath = p; break; }
    }
    if (!loadPath) {
      const name = sanitizeName(runArg.trim());
      const runsDir = join(projectLoopDir(ctx.cwd), "runs", name);
      if (existsSync(runsDir)) {
        const files = readdirSync(runsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".md")).sort().reverse();
        if (files.length > 0) loadPath = join(runsDir, files[0]);
      }
    }
    if (!loadPath) {
      ctx.ui.notify(`Run file not found. Checked:\n${paths.map((p) => `- ${p}`).join("\n")}`, "warning");
      return;
    }

    let loaded: ActiveRun;
    try {
      loaded = JSON.parse(readFileSync(loadPath, "utf8")) as ActiveRun;
    } catch (e) {
      ctx.ui.notify(`Failed to parse run file ${loadPath}: ${e}`, "warning");
      return;
    }

    if (loaded.status === "done" || loaded.status === "stopped" || loaded.status === "max_iterations") {
      ctx.ui.notify(`Run ${loaded.runId} is already ${loaded.status}. Cannot resume.`, "warning");
      return;
    }

    loaded.status = "running";
    loaded.cwd = ctx.cwd;
    loaded.updatedAt = nowStamp();

    activeRun = loaded;
    persistRun(activeRun);
    updateUi(ctx, activeRun);
    ctx.ui.notify(`Resumed loop ${loaded.spec.name} (${loaded.runId}) at iteration ${loaded.iteration}`, "info");

    const step = currentStep(activeRun);
    const prompt = `Loop was interrupted. Resume work on the current step.\n\n${step.taskPrompt}`;
    await queueNext(activeRun, prompt);
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

  pi.registerCommand("tdd_loop", {
    description: "TDD loop engineering orchestrator. Usage: /tdd_loop new|run|stop ...",
    handler: async (args, ctx) => {
      const [subcommandRaw, ...rest] = args.trim().split(/\s+/);
      const subcommand = subcommandRaw?.toLowerCase();
      const subArgs = rest.join(" ");
      try {
        if (subcommand === "new") return await handleNew(subArgs, ctx);
        if (subcommand === "run") return await handleRun(subArgs, ctx);
        if (subcommand === "stop") return await handleStop(subArgs, ctx);
        if (subcommand === "resume") return await handleResume(subArgs, ctx);
        ctx.ui.notify("Usage: /tdd_loop new|run|stop|resume ...", "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  registerLoopAlias("tdd_loop:new", handleNew);
  registerLoopAlias("tdd_loop:run", handleRun);
  registerLoopAlias("tdd_loop:stop", handleStop);
  registerLoopAlias("tdd_loop:resume", handleResume);

  pi.registerTool({
    name: "tdd_loop_report",
    label: "TDD Loop Report",
    description: "Report one loop iteration to the Pi loop orchestrator. The extension then runs the current step verifier and decides progress deterministically.",
    promptSnippet: "Report loop iteration progress; tdd_loop runs the current verifier to decide completion",
    promptGuidelines: [
      "Use tdd_loop_report exactly once at the end of a Pi loop iteration when a /tdd_loop:run prompt asks for it.",
      "Do not claim loop completion in tdd_loop_report; tdd_loop decides completion by running the current verifyCommand.",
      "Set tdd_loop_report blocked=true only when progress requires human input, missing access, ambiguity, or an unsafe action.",
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
        mutateAndPersist(activeRun, (r) => r.history.push(entry));
        appendRunLog(activeRun, entry);
        return stopRun(ctx, "blocked", "Loop blocked.", { accepted: true, finalStatus: "blocked" });
      }

      const verification = await runVerifier(activeRun, signal, step.verifyCommand);
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Verifier was cancelled. Loop state preserved; submit tdd_loop_report again to retry." }],
          details: { accepted: true, finalStatus: "cancelled", runPath: activeRun.runPath },
        };
      }
      const status: LoopStatus = verification.exitCode === 0 ? "done" : "not_done";
      const entry = makeEntry(activeRun, report, status, verification, step);
      mutateAndPersist(activeRun, (r) => r.history.push(entry));
      appendRunLog(activeRun, entry);

      if (status === "done") await autoCommitStep(activeRun, signal, entry);

      if (status === "done" && isDagPlan(activeRun)) {
        if (!activeRun.completedTaskIds.includes(step.id)) activeRun.completedTaskIds.push(step.id);
        activeRun.currentTaskId = selectDagStep(activeRun)?.id;
        if (activeRun.completedTaskIds.length < activeRun.spec.plan.length) {
          mutateAndPersist(activeRun, (r) => { r.iteration += 1; r.stepIteration = 1; });
          updateUi(ctx, activeRun);
          const nextStep = currentStep(activeRun);
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
        mutateAndPersist(activeRun, (r) => { r.currentStepIndex += 1; r.iteration += 1; r.stepIteration = 1; });
        updateUi(ctx, activeRun);
        const nextStep = currentStep(activeRun);
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
          dependsOn: [],
        });
        activeRun.history.push(finalEntry);
        appendRunLog(activeRun, finalEntry);
        if (finalStatus === "done") {
          await autoCommitStep(activeRun, signal, finalEntry);
          return stopRun(ctx, "done", "Loop complete: final verifier passed.", { accepted: true, finalStatus: "done", verification: finalVerification });
        }
        if (activeRun.iteration >= activeRun.spec.maxIterations || activeRun.finalVerifierAttempts >= activeRun.spec.maxIterationsPerStep) {
          return stopRun(ctx, "max_iterations", "Loop stopped at maxIterations: final verifier still fails.", { accepted: true, finalStatus: "max_iterations", verification: finalVerification });
        }
        mutateAndPersist(activeRun, (r) => { r.finalVerifierAttempts += 1; r.iteration += 1; });
        updateUi(ctx, activeRun);
        const finalPrompt = report.nextPrompt?.trim() || `All planned step tests passed, but the final verifier failed: ${activeRun.spec.finalVerifyCommand}. Fix integration/regression failures while preserving the passing step tests, then call tdd_loop_report.`;
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
      mutateAndPersist(activeRun, (r) => { r.iteration += 1; r.stepIteration += 1; });
      updateUi(ctx, activeRun);

      await queueNext(activeRun, nextPrompt);
      return {
        content: [{ type: "text", text: `Verifier failed; queued loop iteration ${activeRun.iteration}/${activeRun.spec.maxIterations}.` }],
        details: { accepted: true, finalStatus: "running", runPath: activeRun.runPath, nextIteration: activeRun.iteration, verification },
        terminate: true,
      };
    },
  });
}
