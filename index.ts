import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const LOOP_CONFIG_DIR = ".pi";
const GLOBAL_LOOP_DIR = join(homedir(), ".pi", "agent", "loops");
const MAX_SAFE_ITERATIONS = 50;
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

type LoopStatus = "done" | "not_done" | "blocked";
type RunStatus = "running" | "done" | "blocked" | "stopped" | "max_iterations";
type LoopMode = "tdd" | "standard";

type LoopSpec = {
  name: string;
  goal: string;
  mode: LoopMode;
  taskPrompt: string;
  verifyCommand: string;
  doneWhen: string;
  maxIterations: number;
  trainingMode: boolean;
  memoryPath?: string;
  verifyTimeoutMs: number;
};

const LoopReportSchema = Type.Object({
  summary: Type.String({ description: "Concise summary of what happened in this iteration." }),
  blocked: Type.Optional(Type.Boolean({ description: "Set true only when human input, missing access, ambiguity, or an unsafe next step blocks progress." })),
  nextPrompt: Type.Optional(Type.String({ description: "Specific prompt for the next iteration if the verifier still fails." })),
  artifacts: Type.Optional(Type.Array(Type.String(), { description: "Files, commands, URLs, or other artifacts created/changed/checked." })),
  lessonsLearned: Type.Optional(Type.Array(Type.String(), { description: "Reusable lessons to persist in loop run memory." })),
});

type LoopReport = Static<typeof LoopReportSchema>;

type HistoryEntry = LoopReport & {
  iteration: number;
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

function appendRunLog(run: ActiveRun, entry: HistoryEntry) {
  ensureDir(dirname(run.logPath));
  const artifacts = entry.artifacts?.length ? `\nArtifacts:\n${entry.artifacts.map((a) => `- ${a}`).join("\n")}` : "";
  const lessons = entry.lessonsLearned?.length ? `\nLessons:\n${entry.lessonsLearned.map((l) => `- ${l}`).join("\n")}` : "";
  const stdout = entry.verifyStdout ? `\n\nStdout:\n\`\`\`\n${entry.verifyStdout}\n\`\`\`` : "";
  const stderr = entry.verifyStderr ? `\n\nStderr:\n\`\`\`\n${entry.verifyStderr}\n\`\`\`` : "";
  appendFileSync(
    run.logPath,
    `\n## Iteration ${entry.iteration} — ${entry.status} — ${entry.timestamp}\n\n${entry.summary}\n\nVerification: ${entry.verification}${artifacts}${lessons}${stdout}${stderr}\n`,
    "utf8",
  );
}

function normalizeSpec(raw: unknown, fallbackName: string): LoopSpec {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopSpec> & {
    iterationPrompt?: string;
    doneRule?: string;
    verificationHint?: string;
  };
  const name = sanitizeName(String(input.name || fallbackName));
  const maxIterations = Math.max(
    1,
    Math.min(MAX_SAFE_ITERATIONS, Number.isFinite(input.maxIterations) ? Math.floor(Number(input.maxIterations)) : 5),
  );
  const verifyTimeoutMs = Math.max(1_000, Number.isFinite(input.verifyTimeoutMs) ? Math.floor(Number(input.verifyTimeoutMs)) : DEFAULT_VERIFY_TIMEOUT_MS);
  return {
    name,
    goal: String(input.goal || "Complete the requested task."),
    mode: input.mode === "standard" ? "standard" : "tdd",
    taskPrompt: String(input.taskPrompt || input.iterationPrompt || "Do one focused iteration toward the goal, then call loop_report."),
    verifyCommand: String(input.verifyCommand || input.verificationHint || "npm test"),
    doneWhen: String(input.doneWhen || input.doneRule || "verifyCommand exits 0"),
    maxIterations,
    trainingMode: input.trainingMode !== false,
    verifyTimeoutMs,
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
    trainingMode: true,
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
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

function formatHistory(run: ActiveRun) {
  if (run.history.length === 0) return "No previous iterations.";
  return run.history
    .map((entry) => {
      const next = entry.nextPrompt ? `\nNext hint: ${entry.nextPrompt}` : "";
      return `Iteration ${entry.iteration} (${entry.status}): ${entry.summary}\nVerification: ${entry.verification}${next}`;
    })
    .join("\n\n");
}

function buildIterationPrompt(run: ActiveRun, promptOverride?: string) {
  const prompt = promptOverride?.trim() || run.spec.taskPrompt;
  const tdd = run.spec.mode === "tdd"
    ? "\nTDD mode:\n- First write or update a failing test that proves the requested behavior.\n- Then implement the smallest fix.\n- Completion verification is the test command passing.\n"
    : "";
  return `You are running Pi loop \"${run.spec.name}\".\n\nGoal:\n${run.spec.goal}\n\nDone when:\n${run.spec.doneWhen}\n\nAuthoritative verifier:\n${run.spec.verifyCommand}\n\nIteration ${run.iteration} of ${run.spec.maxIterations}.\n${tdd}\nPrevious loop history:\n${formatHistory(run)}\n\nThis iteration prompt:\n${prompt}\n\nLoop protocol:\n- Do one focused iteration only.\n- Use available execution skills/tools as needed.\n- You may run checks while working, but final completion is decided by the extension running the authoritative verifier after your report.\n- End by calling loop_report exactly once.\n- Set blocked=true only if progress requires human input, missing access, ambiguity, or an unsafe action.\n- If not blocked, include nextPrompt only when you have a useful hint for a possible next iteration.`;
}

function statusText(run?: ActiveRun) {
  if (!run) return "loop: idle";
  return `loop: ${run.spec.name} ${run.status} ${run.iteration}/${run.spec.maxIterations}`;
}

function updateUi(ctx: { ui?: { setStatus?: (key: string, value?: string) => void; setWidget?: (key: string, value?: string[] | undefined) => void } }, run?: ActiveRun) {
  ctx.ui?.setStatus?.("pi-loop", run ? statusText(run) : undefined);
  if (!run) {
    ctx.ui?.setWidget?.("pi-loop", undefined);
    return;
  }
  const last = run.history.at(-1);
  ctx.ui?.setWidget?.("pi-loop", [
    `↻ Loop: ${run.spec.name} (${run.status}, iteration ${run.iteration}/${run.spec.maxIterations})`,
    `Verifier: ${run.spec.verifyCommand}`,
    last ? `Last: ${last.status} — ${last.verification}` : "Last: not started",
  ]);
}

function startRun(cwd: string, spec: LoopSpec, specPath: string): ActiveRun {
  const startedAt = nowStamp();
  const runId = `${sanitizeName(spec.name)}-${fileStamp()}`;
  const baseRunDir = spec.memoryPath ? resolve(cwd, spec.memoryPath) : join(projectLoopDir(cwd), "runs", sanitizeName(spec.name));
  const runPath = join(baseRunDir, `${runId}.json`);
  const logPath = join(baseRunDir, `${runId}.md`);
  const run: ActiveRun = {
    runId,
    cwd,
    specPath,
    runPath,
    logPath,
    spec,
    iteration: 1,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    history: [],
  };
  writeJson(runPath, run);
  appendFileSync(
    logPath,
    `# Loop run: ${spec.name}\n\n- Run ID: ${runId}\n- Started: ${startedAt}\n- Goal: ${spec.goal}\n- Mode: ${spec.mode}\n- Done when: ${spec.doneWhen}\n- Verifier: ${spec.verifyCommand}\n- Spec: ${specPath}\n`,
    "utf8",
  );
  return run;
}

export default function piLoop(pi: ExtensionAPI) {
  let activeRun: ActiveRun | undefined;

  pi.on("resources_discover", async () => ({
    skillPaths: [join(dirname(__filename), "skills")],
  }));

  async function queueNext(run: ActiveRun, prompt: string) {
    const message = buildIterationPrompt(run, prompt);
    if (pi.getSessionName?.() === undefined) pi.setSessionName?.(`Loop: ${run.spec.name}`);
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch {
      pi.sendUserMessage(message);
    }
  }

  async function runVerifier(run: ActiveRun, signal?: AbortSignal) {
    const command = `cd ${shellQuote(run.cwd)} && ${run.spec.verifyCommand}`;
    const result = await pi.exec("bash", ["-lc", command], { signal, timeout: run.spec.verifyTimeoutMs } as any) as any;
    const exitCode = typeof result.code === "number" ? result.code : null;
    const stdout = trunc(result.stdout);
    const stderr = trunc(result.stderr);
    const verification = `\`${run.spec.verifyCommand}\` exited ${exitCode}${result.killed ? " (killed/timeout)" : ""}`;
    return { exitCode, stdout, stderr, verification };
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
    if (!spec.verifyCommand.trim()) {
      ctx.ui.notify("Loop spec needs a non-empty verifyCommand.", "warning");
      return;
    }
    activeRun = startRun(ctx.cwd, spec, path);
    updateUi(ctx, activeRun);
    ctx.ui.notify(`Started loop ${spec.name} (${activeRun.runId})`, "info");
    await queueNext(activeRun, spec.taskPrompt);
  }

  async function handleStatus(_args: string, ctx: any) {
    if (!activeRun) {
      ctx.ui.notify("No active loop.", "info");
      return;
    }
    updateUi(ctx, activeRun);
    const last = activeRun.history.at(-1);
    ctx.ui.notify(
      `${statusText(activeRun)}\nRun file: ${activeRun.runPath}\nVerifier: ${activeRun.spec.verifyCommand}\n${last ? `Last report: ${last.status} — ${last.verification}` : "No reports yet."}`,
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
    description: "Report one loop iteration to the Pi loop orchestrator. The extension then runs verifyCommand and decides done/not_done deterministically.",
    promptSnippet: "Report loop iteration progress; pi-loop runs verifyCommand to decide completion",
    promptGuidelines: [
      "Use loop_report exactly once at the end of a Pi loop iteration when a /loop:run prompt asks for it.",
      "Do not claim loop completion in loop_report; pi-loop decides completion by running verifyCommand.",
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
      if (report.blocked) {
        const entry: HistoryEntry = {
          ...report,
          iteration: activeRun.iteration,
          timestamp: nowStamp(),
          status: "blocked",
          verification: "Agent reported blocked before verifier could decide completion.",
        };
        activeRun.history.push(entry);
        appendRunLog(activeRun, entry);
        activeRun.status = "blocked";
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const runPath = activeRun.runPath;
        activeRun = undefined;
        updateUi(ctx, undefined);
        return {
          content: [{ type: "text", text: `Loop blocked. Run saved to ${runPath}` }],
          details: { accepted: true, finalStatus: "blocked", runPath },
          terminate: true,
        };
      }

      const verification = await runVerifier(activeRun, signal);
      const status: LoopStatus = verification.exitCode === 0 ? "done" : "not_done";
      const entry: HistoryEntry = {
        ...report,
        iteration: activeRun.iteration,
        timestamp: nowStamp(),
        status,
        verification: verification.verification,
        verifyCommand: activeRun.spec.verifyCommand,
        verifyExitCode: verification.exitCode,
        verifyStdout: verification.stdout,
        verifyStderr: verification.stderr,
      };
      activeRun.history.push(entry);
      appendRunLog(activeRun, entry);

      if (status === "done") {
        activeRun.status = "done";
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const runPath = activeRun.runPath;
        activeRun = undefined;
        updateUi(ctx, undefined);
        return {
          content: [{ type: "text", text: `Loop complete: verifier passed. Run saved to ${runPath}` }],
          details: { accepted: true, finalStatus: "done", runPath, verification },
          terminate: true,
        };
      }

      if (activeRun.iteration >= activeRun.spec.maxIterations) {
        activeRun.status = "max_iterations";
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const runPath = activeRun.runPath;
        activeRun = undefined;
        updateUi(ctx, undefined);
        return {
          content: [{ type: "text", text: `Loop stopped at maxIterations: verifier still fails. Run saved to ${runPath}` }],
          details: { accepted: true, finalStatus: "max_iterations", runPath, verification },
          terminate: true,
        };
      }

      const nextPrompt = report.nextPrompt?.trim() || activeRun.spec.taskPrompt;
      activeRun.iteration += 1;
      persistRun(activeRun);
      updateUi(ctx, activeRun);

      if (activeRun.spec.trainingMode && ctx.hasUI) {
        const shouldContinue = await ctx.ui.confirm(
          `Continue loop ${activeRun.spec.name}?`,
          `Next iteration: ${activeRun.iteration}/${activeRun.spec.maxIterations}\n\nVerifier failed: ${verification.verification}\n\nLast summary: ${report.summary}`,
        );
        if (!shouldContinue) {
          activeRun.status = "stopped";
          persistRun(activeRun);
          const runPath = activeRun.runPath;
          activeRun = undefined;
          updateUi(ctx, undefined);
          return {
            content: [{ type: "text", text: `Loop paused by user. Run saved to ${runPath}` }],
            details: { accepted: true, finalStatus: "stopped", runPath, verification },
            terminate: true,
          };
        }
      }

      const run = activeRun;
      await queueNext(run, nextPrompt);
      return {
        content: [{ type: "text", text: `Verifier failed; queued loop iteration ${run.iteration}/${run.spec.maxIterations}.` }],
        details: { accepted: true, finalStatus: "running", runPath: run.runPath, nextIteration: run.iteration, verification },
        terminate: true,
      };
    },
  });
}
