import { randomInt } from "node:crypto";
import type { AppConfig } from "../config/load";
import type { Mode } from "../config/schemas";
import { applicablePrompts, renderPrompt } from "./applicability";

export interface JobSpec {
  hotel_id: string;
  prompt_id: string;
  prompt_type: "discovery" | "brand";
  prompt_text_rendered: string;
  engine_id: string;
  model: string;
  mode: Mode;
  repetition: number;
}

/**
 * All jobs for a run: applicable hotel×prompt pairs × enabled engine×mode pairs × repetitions.
 * Returned in random order so time-of-day effects don't cluster on one engine.
 */
export function buildJobs(
  config: AppConfig,
  repetitions: number,
  random: (n: number) => number = (n) => randomInt(n),
): JobSpec[] {
  const jobs: JobSpec[] = [];
  const engines = config.engines.engines.filter((e) => e.enabled);

  for (const hotel of config.hotels) {
    for (const prompt of applicablePrompts(config.prompts, hotel)) {
      const text = renderPrompt(prompt, hotel);
      for (const engine of engines) {
        for (const mode of engine.modes) {
          for (let rep = 1; rep <= repetitions; rep++) {
            jobs.push({
              hotel_id: hotel.hotel_id,
              prompt_id: prompt.id,
              prompt_type: prompt.type,
              prompt_text_rendered: text,
              engine_id: engine.engine_id,
              model: engine.model,
              mode,
              repetition: rep,
            });
          }
        }
      }
    }
  }
  return shuffle(jobs, random);
}

/** Fisher–Yates shuffle (copy). */
export function shuffle<T>(items: T[], random: (n: number) => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
