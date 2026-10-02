import type { Hotel, PromptTemplate } from "../config/schemas";

/**
 * Does this prompt template apply to this hotel?
 * - No applies_if tags and no min_stars → applies to all hotels.
 * - Otherwise it applies if ANY listed tag matches, OR the hotel has at least min_stars.
 *   (LUX-01 = "luxury OR min_stars 4".)
 */
export function promptApplies(prompt: PromptTemplate, hotel: Hotel): boolean {
  const hasTags = prompt.applies_if.length > 0;
  const hasStars = prompt.min_stars !== undefined;
  if (!hasTags && !hasStars) return true;
  const tagMatch = hasTags && prompt.applies_if.some((t) => hotel.tags.includes(t));
  const starMatch = hasStars && hotel.stars >= (prompt.min_stars as number);
  return tagMatch || starMatch;
}

/** Fill {hotel_name}, {city}, {region}, {stars} into the template text. */
export function renderPrompt(prompt: PromptTemplate, hotel: Hotel): string {
  const values: Record<string, string> = {
    hotel_name: hotel.name,
    city: hotel.city,
    region: hotel.region,
    stars: String(hotel.stars),
  };
  return prompt.text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function applicablePrompts(prompts: PromptTemplate[], hotel: Hotel): PromptTemplate[] {
  return prompts.filter((p) => promptApplies(p, hotel));
}
