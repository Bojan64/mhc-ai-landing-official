import { z } from "zod";

// Optional free-text note allowed in config objects (JSON has no comments).
const note = { _note: z.string().optional() };

export const HOTEL_TAGS = [
  "spa", "family", "couples", "adults_only", "business",
  "events", "pets", "beach", "luxury", "budget",
] as const;

export const GROUND_TRUTH_BOOLEAN_KEYS = [
  "pool_indoor", "pool_outdoor", "spa_wellness", "beach_access", "parking",
  "pets_allowed", "restaurant", "family_friendly", "adults_only",
  "business_facilities", "event_facilities",
] as const;

export const PRICE_LEVELS = ["budget", "mid-range", "upper-mid", "luxury"] as const;

export const MODES = ["no_search", "web_search"] as const;
export type Mode = (typeof MODES)[number];

export const PROVIDERS = ["openai", "anthropic", "google", "perplexity"] as const;

const booleanFacts = Object.fromEntries(
  GROUND_TRUTH_BOOLEAN_KEYS.map((k) => [k, z.boolean().optional()]),
) as Record<(typeof GROUND_TRUTH_BOOLEAN_KEYS)[number], z.ZodOptional<z.ZodBoolean>>;

// All keys optional: a missing fact makes the related fact check "needs_review".
export const GroundTruthSchema = z.strictObject({
  ...booleanFacts,
  star_rating: z.number().min(0).max(5).optional(),
  distance_to_sea: z.number().min(0).optional(), // km
  price_level: z.enum(PRICE_LEVELS).optional(),
});

const CompetitorSchema = z.strictObject({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const HotelSchema = z.strictObject({
  ...note,
  hotel_id: z.string().regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, - or _ only"),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  website_domain: z
    .string()
    .regex(/^(?!https?:\/\/)(?!www\.)[a-z0-9.-]+\.[a-z]{2,}$/i, "plain domain like hotel-x.si (no http://, no www.)"),
  city: z.string().min(1),
  region: z.string().min(1),
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.enum(HOTEL_TAGS)),
  competitor_ids: z.array(z.string()).default([]),
  extra_competitors: z.array(CompetitorSchema).default([]),
  ground_truth: GroundTruthSchema,
  ground_truth_confirmed_by_hotel: z.boolean(),
});
export type Hotel = z.infer<typeof HotelSchema>;
export const HotelsFileSchema = z.array(HotelSchema).min(1);

export const PLACEHOLDERS = ["hotel_name", "city", "region", "stars"] as const;

export const PromptSchema = z.strictObject({
  ...note,
  id: z.string().min(1),
  language: z.string().regex(/^[a-z]{2}$/, "two-letter language code, e.g. en"),
  category: z.string().min(1),
  type: z.enum(["discovery", "brand"]),
  applies_if: z.array(z.enum(HOTEL_TAGS)).default([]),
  min_stars: z.number().int().min(1).max(5).optional(),
  text: z.string().min(1),
});
export type PromptTemplate = z.infer<typeof PromptSchema>;
export const PromptsFileSchema = z.array(PromptSchema).min(1);

const PricingSchema = z.strictObject({
  input_per_million: z.number().min(0).nullable(),
  output_per_million: z.number().min(0).nullable(),
  per_search: z.number().min(0).nullable(),
});
export type Pricing = z.infer<typeof PricingSchema>;

const CallAssumptionSchema = z.strictObject({
  input_tokens: z.number().min(0),
  output_tokens: z.number().min(0),
  searches_per_call: z.number().min(0),
});
export type CallAssumption = z.infer<typeof CallAssumptionSchema>;

const EngineSchema = z.strictObject({
  ...note,
  engine_id: z.string().regex(/^[a-z0-9_-]+$/),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  modes: z.array(z.enum(MODES)).min(1),
  enabled: z.boolean(),
  max_concurrency: z.number().int().min(1),
  requests_per_minute: z.number().int().min(1),
  // null = provider default (intentional for tested engines).
  temperature: z.number().min(0).max(2).nullable(),
  pricing: PricingSchema,
  // Per-engine override of the global cost assumptions.
  cost_assumptions: z.partialRecord(z.enum(MODES), CallAssumptionSchema).optional(),
});
export type Engine = z.infer<typeof EngineSchema>;

export const EnginesFileSchema = z.strictObject({
  ...note,
  usd_to_eur: z.number().positive(),
  system_instruction: z.string(),
  // "neutral" = no user location sent anywhere (OpenAI would otherwise assume the US).
  user_location: z.literal("neutral"),
  cost_assumptions: z.strictObject({
    ...note,
    no_search: CallAssumptionSchema,
    web_search: CallAssumptionSchema,
    analyzer: CallAssumptionSchema.omit({ searches_per_call: true }),
  }),
  engines: z.array(EngineSchema).min(1),
  analyzer: z.strictObject({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(1),
    max_concurrency: z.number().int().min(1),
    requests_per_minute: z.number().int().min(1),
    pricing: PricingSchema,
  }),
});
export type EnginesConfig = z.infer<typeof EnginesFileSchema>;

export const SCORE_COMPONENTS = [
  "presence", "position", "factual_accuracy",
  "source_authority", "competitive_position", "direct_booking",
] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export const ScoringSchema = z.strictObject({
  ...note,
  version: z.string(),
  weights: z.strictObject(
    Object.fromEntries(SCORE_COMPONENTS.map((c) => [c, z.number().min(0)])) as Record<
      ScoreComponent,
      z.ZodNumber
    >,
  ),
  engine_weights: z.record(z.string(), z.number().min(0)),
  max_position_counted: z.number().int().min(1),
});
export type ScoringConfig = z.infer<typeof ScoringSchema>;

export const SOURCE_TYPES = ["ota", "metasearch", "review", "tourism_board"] as const;

export const SourceDomainsSchema = z.strictObject({
  ...note,
  ota: z.array(z.string().min(1)),
  metasearch: z.array(z.string().min(1)),
  review: z.array(z.string().min(1)),
  tourism_board: z.array(z.string().min(1)),
});
export type SourceDomains = z.infer<typeof SourceDomainsSchema>;
