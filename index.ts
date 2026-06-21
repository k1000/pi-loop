import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const LOOP_CONFIG_DIR = ".pi";
const GLOBAL_LOOP_DIR = join(homedir(), ".pi", "agent", "loops");
const MAX_SAFE_ITERATIONS = 50;

type LoopStatus = "done" | "not_done" | "blocked";
type RunStatus = "running" | "done" | "blocked" | "stopped" | "max_iterations";

type LoopSpec = {
  name: string;
  goal: string;
  maxIterations: number;
  trainingMode: boolean;
  iterationPrompt: string;
  doneRule: string;
  memoryPath?: string;
  verificationHint?: string;
};

type LoopReport = Static<typeof LoopReportSchema>;

type HistoryEntry = LoopReport & {
  iteration: number;
  timestamp: string;
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

const LoopReportSchema = Type.Object({
  status: StringEnum(["done", "not_done", "blocked"] as const, {
    description: "done when the loop goal is verified, not_done when another iteration should run, blocked when human/input/tool access is required.",
  }),
  summary: Type.String({ description: "Concise summary of what happened in this iteration." }),
  verification: Type.String({ description: "What was checked, with command/output/result if applicable." }),
  nextPrompt: Type.Optional(Type.String({ description: "Specific prompt for the next iteration if status is not_done." })),
  artifacts: Type.Optional(Type.Array(Type.String(), { description: "Files, commands, URLs, or other artifacts created/changed/checked." })),
  lessonsLearned: Type.Optional(Type.Array(Type.String(), { description: "Reusable lessons to persist in loop run memory." })),
});

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

function appendRunLog(run: ActiveRun, entry: HistoryEntry) {
  ensureDir(dirname(run.logPath));
  const artifacts = entry.artifacts?.length ? `\nArtifacts:\n${entry.artifacts.map((a) => `- ${a}`).join("\n")}` : "";
  const lessons = entry.lessonsLearned?.length ? `\nLessons:\n${entry.lessonsLearned.map((l) => `- ${l}`).join("\n")}` : "";
  appendFileSync(
    run.logPath,
    `\n## Iteration ${entry.iteration} — ${entry.status} — ${entry.timestamp}\n\n${entry.summary}\n\nVerification: ${entry.verification}${artifacts}${lessons}\n`,
    "utf8",
  );
}

function normalizeSpec(raw: unknown, fallbackName: string): LoopSpec {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<LoopSpec>;
  const name = sanitizeName(String(input.name || fallbackName));
  const maxIterations = Math.max(
    1,
    Math.min(MAX_SAFE_ITERATIONS, Number.isFinite(input.maxIterations) ? Math.floor(Number(input.maxIterations)) : 5),
  );
  const spec: LoopSpec = {
    name,
    goal: String(input.goal || "Complete the requested task."),
    maxIterations,
    trainingMode: input.trainingMode !== false,
    iterationPrompt: String(input.iterationPrompt || "Make the smallest useful progress toward the goal, verify it, then call loop_report."),
    doneRule: String(input.doneRule || "The goal is objectively verified as complete."),
  };
  if (input.memoryPath) spec.memoryPath = String(input.memoryPath);
  if (input.verificationHint) spec.verificationHint = String(input.verificationHint);
  return spec;
}

function defaultSpec(name: string): LoopSpec {
  const safeName = sanitizeName(name);
  return {
    name: safeName,
    goal: "Describe the concrete goal this loop should finish.",
    maxIterations: 5,
    trainingMode: true,
    iterationPrompt: "Do one focused iteration toward the goal. Use available skills/tools, make the smallest safe change, verify it, then call loop_report.",
    doneRule: "The verification evidence proves the goal is complete.",
    verificationHint: "Prefer deterministic commands/checks. For subjective goals, provide an explicit score or approval signal.",
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
      const next = entry.nextPrompt ? `\nNext prompt requested: ${entry.nextPrompt}` : "";
      return `Iteration ${entry.iteration} (${entry.status}): ${entry.summary}\nVerification: ${entry.verification}${next}`;
    })
    .join("\n\n");
}

function buildIterationPrompt(run: ActiveRun, promptOverride?: string) {
  const prompt = promptOverride?.trim() || run.spec.iterationPrompt;
  return `You are running Pi loop \"${run.spec.name}\".\n\nGoal:\n${run.spec.goal}\n\nDefinition of done:\n${run.spec.doneRule}\n\nVerification hint:\n${run.spec.verificationHint || "Use the strongest available verification evidence."}\n\nIteration ${run.iteration} of ${run.spec.maxIterations}.\n\nPrevious loop history:\n${formatHistory(run)}\n\nThis iteration prompt:\n${prompt}\n\nLoop protocol:\n- Do one focused iteration only.\n- Use the available execution skills/tools as needed.\n- Verify the work against the definition of done.\n- End by calling loop_report exactly once with status \"done\", \"not_done\", or \"blocked\".\n- If status is \"not_done\", include a concise nextPrompt for the next iteration.\n- Do not claim done without verification evidence.`;
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
    `Goal: ${run.spec.goal}`,
    last ? `Last: ${last.status} — ${last.summary}` : "Last: not started",
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
    `# Loop run: ${spec.name}\n\n- Run ID: ${runId}\n- Started: ${startedAt}\n- Goal: ${spec.goal}\n- Done rule: ${spec.doneRule}\n- Spec: ${specPath}\n`,
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
      const edited = await ctx.ui.editor("Edit loop spec JSON", specText);
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
    activeRun = startRun(ctx.cwd, spec, path);
    updateUi(ctx, activeRun);
    ctx.ui.notify(`Started loop ${spec.name} (${activeRun.runId})`, "info");
    await queueNext(activeRun, spec.iterationPrompt);
  }

  async function handleStatus(_args: string, ctx: any) {
    if (!activeRun) {
      ctx.ui.notify("No active loop.", "info");
      return;
    }
    updateUi(ctx, activeRun);
    const last = activeRun.history.at(-1);
    ctx.ui.notify(
      `${statusText(activeRun)}\nRun file: ${activeRun.runPath}\n${last ? `Last report: ${last.status} — ${last.summary}` : "No reports yet."}`,
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
    description: "Report one loop iteration status to the Pi loop orchestrator. Use exactly once at the end of each loop iteration.",
    promptSnippet: "Report loop iteration status: done, not_done, or blocked",
    promptGuidelines: [
      "Use loop_report exactly once at the end of a Pi loop iteration when a /loop:run prompt asks for it.",
      "Do not use loop_report outside an active Pi loop run.",
    ],
    parameters: LoopReportSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRun || activeRun.status !== "running") {
        return {
          content: [{ type: "text", text: "No active loop run is waiting for a report." }],
          details: { accepted: false },
          terminate: true,
        };
      }

      const report = params as LoopReport;
      const entry: HistoryEntry = { ...report, iteration: activeRun.iteration, timestamp: nowStamp() };
      activeRun.history.push(entry);
      appendRunLog(activeRun, entry);

      if (report.status === "done") {
        activeRun.status = "done";
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const runPath = activeRun.runPath;
        activeRun = undefined;
        updateUi(ctx, undefined);
        return {
          content: [{ type: "text", text: `Loop complete. Run saved to ${runPath}` }],
          details: { accepted: true, finalStatus: "done", runPath },
          terminate: true,
        };
      }

      if (report.status === "blocked") {
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

      if (activeRun.iteration >= activeRun.spec.maxIterations) {
        activeRun.status = "max_iterations";
        persistRun(activeRun);
        updateUi(ctx, activeRun);
        const runPath = activeRun.runPath;
        activeRun = undefined;
        updateUi(ctx, undefined);
        return {
          content: [{ type: "text", text: `Loop stopped at maxIterations. Run saved to ${runPath}` }],
          details: { accepted: true, finalStatus: "max_iterations", runPath },
          terminate: true,
        };
      }

      const nextPrompt = report.nextPrompt?.trim() || activeRun.spec.iterationPrompt;
      activeRun.iteration += 1;
      persistRun(activeRun);
      updateUi(ctx, activeRun);

      if (activeRun.spec.trainingMode && ctx.hasUI) {
        const shouldContinue = await ctx.ui.confirm(
          `Continue loop ${activeRun.spec.name}?`,
          `Next iteration: ${activeRun.iteration}/${activeRun.spec.maxIterations}\n\nLast status: ${report.status}\n${report.summary}\n\nVerification: ${report.verification}`,
        );
        if (!shouldContinue) {
          activeRun.status = "stopped";
          persistRun(activeRun);
          const runPath = activeRun.runPath;
          activeRun = undefined;
          updateUi(ctx, undefined);
          return {
            content: [{ type: "text", text: `Loop paused by user. Run saved to ${runPath}` }],
            details: { accepted: true, finalStatus: "stopped", runPath },
            terminate: true,
          };
        }
      }

      const run = activeRun;
      await queueNext(run, nextPrompt);
      return {
        content: [{ type: "text", text: `Queued loop iteration ${run.iteration}/${run.spec.maxIterations}.` }],
        details: { accepted: true, finalStatus: "running", runPath: run.runPath, nextIteration: run.iteration },
        terminate: true,
      };
    },
  });
}
