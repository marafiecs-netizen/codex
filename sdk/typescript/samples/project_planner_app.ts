#!/usr/bin/env -S NODE_NO_WARNINGS=1 pnpm ts-node-esm --files

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { codexPathOverride } from "./helpers.ts";

type TaskSource = "manual" | "codex";

type Task = {
  id: number;
  title: string;
  rationale: string | null;
  done: boolean;
  source: TaskSource;
};

const tasks: Task[] = [];
let nextTaskId = 1;

const plannerSchema = z
  .object({
    summary: z.string(),
    tasks: z
      .array(
        z.object({
          title: z.string(),
          rationale: z.string(),
        }),
      )
      .min(1, "Generate at least one task"),
  })
  .strict();

type PlannerResult = z.infer<typeof plannerSchema>;

const codex = new Codex({
  codexPathOverride: codexPathOverride(),
});

const thread = codex.startThread({
  skipGitRepoCheck: true,
});

function addTask(title: string, rationale: string | null, source: TaskSource): Task {
  const task: Task = {
    id: nextTaskId++,
    title,
    rationale,
    done: false,
    source,
  };
  tasks.push(task);
  return task;
}

function formatTask(task: Task): string {
  const status = task.done ? "x" : " ";
  const origin = task.source === "codex" ? "🤖" : "📝";
  const rationale = task.rationale ? ` — ${task.rationale}` : "";
  return `${origin} [${task.id}] [${status}] ${task.title}${rationale}`;
}

function printTasks(): void {
  if (tasks.length === 0) {
    console.log("No tasks yet. Use `add` or `plan` to create some.");
    return;
  }
  for (const task of tasks) {
    console.log(formatTask(task));
  }
}

function toggleTask(id: number): void {
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    console.log(`Task ${id} was not found.`);
    return;
  }
  task.done = !task.done;
  console.log(`${task.done ? "Completed" : "Reopened"} task ${id}.`);
}

function formatBacklogForPrompt(): string {
  if (tasks.length === 0) {
    return "- No tasks currently tracked.";
  }
  return tasks
    .map((task) => `- [${task.done ? "x" : " "}] ${task.title}`)
    .join("\n");
}

async function generatePlan(goal: string): Promise<void> {
  console.log(`Planning steps for: ${goal}`);
  const prompt = [
    {
      type: "text" as const,
      text:
        "You are a meticulous project planner helping a developer break work into actionable tasks. " +
        "Return a concise summary plus a bullet list of new tasks. Focus on tasks that can be completed " +
        "individually without hidden dependencies.",
    },
    {
      type: "text" as const,
      text: `Existing backlog:\n${formatBacklogForPrompt()}`,
    },
    {
      type: "text" as const,
      text: `Goal: ${goal}`,
    },
  ];

  const schema = zodToJsonSchema(plannerSchema, { target: "openAi" });
  const turn = await thread.run(prompt, { outputSchema: schema });

  let structured: PlannerResult;
  try {
    const parsed = JSON.parse(turn.finalResponse);
    structured = plannerSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse planner response: ${message}\nRaw response: ${turn.finalResponse}`);
  }

  console.log(`\nSummary: ${structured.summary}\n`);

  for (const task of structured.tasks) {
    const created = addTask(task.title, task.rationale, "codex");
    console.log(`Added task ${created.id}: ${created.title}`);
  }
}

function printHelp(): void {
  console.log(`Commands:\n` +
    `  help                Show this help text.\n` +
    `  list                Display the current task list.\n` +
    `  add <task>          Add a task without Codex assistance.\n` +
    `  toggle <id>         Toggle completion for a task.\n` +
    `  plan <goal>         Ask Codex to break a goal into tasks.\n` +
    `  exit                Quit the planner.`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("Codex Project Planner\nType `help` to see available commands.\n");

  try {
    while (true) {
      const line = await rl.question("planner> ");
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const [command, ...rest] = trimmed.split(" ");
      switch (command.toLowerCase()) {
        case "help":
          printHelp();
          break;
        case "list":
          printTasks();
          break;
        case "add": {
          const title = rest.join(" ").trim();
          if (title.length === 0) {
            console.log("Provide a task description after `add`.");
            break;
          }
          const task = addTask(title, null, "manual");
          console.log(`Added task ${task.id}.`);
          break;
        }
        case "toggle": {
          const id = Number.parseInt(rest[0], 10);
          if (Number.isNaN(id)) {
            console.log("Usage: toggle <id>");
            break;
          }
          toggleTask(id);
          break;
        }
        case "plan": {
          const goal = rest.join(" ").trim();
          if (goal.length === 0) {
            console.log("Usage: plan <goal>");
            break;
          }
          try {
            await generatePlan(goal);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
          }
          break;
        }
        case "exit":
        case "quit":
          return;
        default:
          console.log(`Unknown command: ${command}`);
          printHelp();
          break;
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unexpected error: ${message}`);
  process.exit(1);
});
