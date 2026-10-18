import { z } from "zod";

const note = { _note: z.string().optional() };

export const DestinationSchema = z.strictObject({
  destination_id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  country: z.string().min(1),
  // Lower-case words; a stated hotel location containing one of them counts as "in the destination".
  location_match: z.array(z.string().min(1)).min(1),
});
export type Destination = z.infer<typeof DestinationSchema>;

export const QuestionSchema = z.strictObject({
  id: z.string().min(1),
  segment: z.string().min(1),
  text: z.string().min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

const PriceStatusSchema = z.strictObject({
  status: z.enum(["verified", "unverified"]),
  note: z.string(),
});

export const DestinationFileSchema = z.strictObject({
  ...note,
  destinations: z.array(DestinationSchema).min(1),
  engines: z.array(z.string().min(1)).min(1),
  questions: z.array(QuestionSchema).min(1),
  price_status: z.record(z.string(), z.union([PriceStatusSchema, z.string()])),
});
export type DestinationFile = z.infer<typeof DestinationFileSchema>;

export const PLACEHOLDER = "{d}";

// ---- what the analyzer must return (one tool call per answer) ----

// Where the answer tells the guest to book THIS accommodation. Only an explicit instruction counts:
// cited sources (a review score from Booking.com) and bare links to the hotel's own site do not.
export const BOOKING_TARGETS = ["direct", "ota", "portal", "unspecified"] as const;
export const SENTIMENTS = ["recommended", "neutral", "not_recommended"] as const;
export const LODGING_TYPES = ["hotel", "guesthouse", "apartment", "hostel", "camp", "resort", "other"] as const;

/** Version of the analyzer prompt and output. Raise it whenever the prompt or the meaning of a field changes: "destination-reanalyze" re-analyses answers whose newest analysis has another version. */
export const ANALYZER_VERSION = "v4";
export const ANALYZER_VERSIONS = ["v1", "v2", "v3", "v4"] as const;

/** Longest sentiment_quote kept as written; a longer one is cut by the code (the model is asked for at most 20 words). */
export const MAX_QUOTE_WORDS = 25;

/** Words in a string, split on whitespace. */
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Cuts a quote to `max` words and adds "…"; shorter quotes are returned unchanged. */
export function truncateQuote(quote: string, max = MAX_QUOTE_WORDS): { quote: string; truncated: boolean } {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return { quote, truncated: false };
  return { quote: `${words.slice(0, max).join(" ")}…`, truncated: true };
}

const hotelFields = {
  name: z.string().min(1),
  lodging_type: z.enum(LODGING_TYPES),
  location_stated: z.string().nullable(),
  sentiment: z.enum(SENTIMENTS),
  // Exact words from the answer that the sentiment is based on (the model is asked for at most 20; the code cuts at 25).
  sentiment_quote: z.string(),
  booking_target: z.enum(BOOKING_TARGETS),
  // The exact explicit pointer to book THIS accommodation; null when booking_target is "unspecified".
  booking_evidence: z.string().nullable(),
  // Sources the answer cites for this accommodation (e.g. "Booking.com", "Tripadvisor"): NOT booking instructions.
  cited_sources: z.array(z.string()),
  // URLs attached to this accommodation in the answer (its own site, tourism board, ...), whatever their role.
  linked_urls: z.array(z.string()),
  // Name (as written in the answer) of another listed accommodation this one may be the same as. Never merged automatically.
  possible_duplicate_of: z.string().nullable(),
  quote: z.string(),
};

/** What the analyzer model returns (the tool schema). Version and truncation flag are added by the code. */
export const ModelHotelSchema = z.strictObject(hotelFields);
export const ModelAnalysisSchema = z.strictObject({
  // In order of first mention in the answer.
  hotels: z.array(ModelHotelSchema),
  no_hotels_reason: z.string().nullable(),
});
export type ModelAnalysis = z.infer<typeof ModelAnalysisSchema>;

// Added by the code after the model: quote cut, booking pointer demoted by the safety net.
const codeFields = {
  quote_truncated: z.boolean(),
  // true = the model gave a booking_target but its booking_evidence is no explicit pointer to book this accommodation,
  // so the code set booking_target to "unspecified". The model's value and the reason are kept.
  booking_demoted: z.boolean(),
  booking_demoted_from: z.enum(BOOKING_TARGETS).nullable(),
  booking_demoted_reason: z.string().nullable(),
};
export const AnalyzedHotelSchema = z.strictObject({ ...hotelFields, ...codeFields });
export type AnalyzedHotel = z.infer<typeof AnalyzedHotelSchema>;

/** What is stored and used everywhere after the analyzer. */
export const AnalysisSchema = z.strictObject({
  analyzer_version: z.enum(ANALYZER_VERSIONS),
  hotels: z.array(AnalyzedHotelSchema),
  no_hotels_reason: z.string().nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---- analyses stored by older analyzer versions (kept in the database, never rewritten) ----

// v3: like the current format but without the booking-demotion fields (prompt-only booking rule).
const V3HotelSchema = z.strictObject({ ...hotelFields, quote_truncated: z.boolean() });
const V3AnalysisSchema = z.strictObject({ analyzer_version: z.literal("v3"), hotels: z.array(V3HotelSchema), no_hotels_reason: z.string().nullable() });
const noDemotion = { booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null } as const;

// v2: new fields, but no analyzer_version / quote_truncated, and a looser booking rule.
const V2HotelSchema = z.strictObject(hotelFields);
const V2AnalysisSchema = z.strictObject({ hotels: z.array(V2HotelSchema), no_hotels_reason: z.string().nullable() });

// v1: recommended flag and link-based booking pointer.
const V1HotelSchema = z.strictObject({
  name: z.string().min(1),
  lodging_type: z.enum(LODGING_TYPES),
  recommended: z.boolean(),
  location_stated: z.string().nullable(),
  booking_target: z.enum(["hotel_site", "ota", "other_link", "none"]),
  booking_evidence: z.string().nullable(),
  quote: z.string(),
});
const V1AnalysisSchema = z.strictObject({ hotels: z.array(V1HotelSchema), no_hotels_reason: z.string().nullable() });

/**
 * Reads a stored analysis of any version. Older ones are shown in the current shape without guessing:
 * v1 booking pointers become "unspecified" (v1 counted cited sources and links); v2 and v3 are kept as written (their booking values were not checked by the code).
 * `legacy` = the analysis is not from the current analyzer version.
 */
export function parseStoredAnalysis(json: string): { analysis: Analysis; legacy: boolean } | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  const cur = AnalysisSchema.safeParse(raw);
  if (cur.success) return { analysis: cur.data, legacy: cur.data.analyzer_version !== ANALYZER_VERSION };
  const v3 = V3AnalysisSchema.safeParse(raw);
  if (v3.success) {
    return { legacy: true, analysis: { analyzer_version: "v3", no_hotels_reason: v3.data.no_hotels_reason, hotels: v3.data.hotels.map((h) => ({ ...h, ...noDemotion })) } };
  }
  const v2 = V2AnalysisSchema.safeParse(raw);
  if (v2.success) {
    return { legacy: true, analysis: { analyzer_version: "v2", no_hotels_reason: v2.data.no_hotels_reason, hotels: v2.data.hotels.map((h) => ({ ...h, quote_truncated: false, ...noDemotion })) } };
  }
  const v1 = V1AnalysisSchema.safeParse(raw);
  if (!v1.success) return null;
  return {
    legacy: true,
    analysis: {
      analyzer_version: "v1",
      no_hotels_reason: v1.data.no_hotels_reason,
      hotels: v1.data.hotels.map((h) => ({
        name: h.name, lodging_type: h.lodging_type, location_stated: h.location_stated,
        sentiment: h.recommended ? "recommended" : "not_recommended", sentiment_quote: "", quote_truncated: false, ...noDemotion,
        booking_target: "unspecified", booking_evidence: null, cited_sources: [],
        linked_urls: h.booking_evidence && /^https?:\/\//.test(h.booking_evidence) ? [h.booking_evidence] : [],
        possible_duplicate_of: null, quote: h.quote,
      })),
    },
  };
}

// ---- hand-checked facts about hotels (config/destination-facts.json) ----

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-10-18");

export const HotelFactSchema = z.strictObject({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  status: z.enum(["closed", "open"]),
  // The status holds for answers given before this date; null = no known end.
  valid_until: IsoDate.nullable(),
  source: z.string().min(1),
  checked_on: IsoDate,
});
export type HotelFact = z.infer<typeof HotelFactSchema>;

export const FactsFileSchema = z.strictObject({ ...note, facts: z.array(HotelFactSchema) });
