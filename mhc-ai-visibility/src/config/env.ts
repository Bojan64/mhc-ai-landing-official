import { existsSync } from "node:fs";

export interface Env {
  budgetEur: number | null;
  repetitions: number;
}

/** Load .env (if present) into process.env. Never prints values. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const budget = env.BUDGET_EUR?.trim();
  const reps = env.REPETITIONS?.trim();
  const budgetEur = budget ? Number(budget) : null;
  if (budgetEur !== null && !(budgetEur > 0)) throw new Error("BUDGET_EUR must be a positive number");
  const repetitions = reps ? Number(reps) : 3;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("REPETITIONS must be a whole number ≥ 1");
  return { budgetEur, repetitions };
}
