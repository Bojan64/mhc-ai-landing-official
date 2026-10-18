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

/** Words in a string, split on whitespace. */
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const AnalyzedHotelSchema = z.strictObject({
  name: z.string().min(1),
  lodging_type: z.enum(LODGING_TYPES),
  location_stated: z.string().nullable(),
  sentiment: z.enum(SENTIMENTS),
  // Exact words from the answer (at most 25) that the sentiment is based on.
  sentiment_quote: z.string().refine((q) => wordCount(q) <= 25, "sentiment_quote has more than 25 words"),
  booking_target: z.enum(BOOKING_TARGETS),
  // The exact instruction that shows booking_target; null when booking_target is "unspecified".
  booking_evidence: z.string().nullable(),
  // Sources the answer cites for this accommodation (e.g. "Booking.com", "Tripadvisor"): NOT booking instructions.
  cited_sources: z.array(z.string()),
  // URLs attached to this accommodation in the answer (its own site, tourism board, ...), whatever their role.
  linked_urls: z.array(z.string()),
  // Name (as written in the answer) of another listed accommodation this one may be the same as. Never merged automatically.
  possible_duplicate_of: z.string().nullable(),
  quote: z.string(),
});
export type AnalyzedHotel = z.infer<typeof AnalyzedHotelSchema>;

export const AnalysisSchema = z.strictObject({
  // In order of first mention in the answer.
  hotels: z.array(AnalyzedHotelSchema),
  no_hotels_reason: z.string().nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---- analyses stored by the first analyzer version (kept in the database, never rewritten) ----

const LegacyHotelSchema = z.strictObject({
  name: z.string().min(1),
  lodging_type: z.enum(LODGING_TYPES),
  recommended: z.boolean(),
  location_stated: z.string().nullable(),
  booking_target: z.enum(["hotel_site", "ota", "other_link", "none"]),
  booking_evidence: z.string().nullable(),
  quote: z.string(),
});
const LegacyAnalysisSchema = z.strictObject({ hotels: z.array(LegacyHotelSchema), no_hotels_reason: z.string().nullable() });

/**
 * Reads a stored analysis. Old (v1) rows are shown in the new shape without guessing: their booking pointer
 * is "unspecified" (v1 counted cited sources and links as pointers), the sentiment quote is empty.
 */
export function parseStoredAnalysis(json: string): { analysis: Analysis; legacy: boolean } | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  const v2 = AnalysisSchema.safeParse(raw);
  if (v2.success) return { analysis: v2.data, legacy: false };
  const v1 = LegacyAnalysisSchema.safeParse(raw);
  if (!v1.success) return null;
  return {
    legacy: true,
    analysis: {
      no_hotels_reason: v1.data.no_hotels_reason,
      hotels: v1.data.hotels.map((h) => ({
        name: h.name, lodging_type: h.lodging_type, location_stated: h.location_stated,
        sentiment: h.recommended ? "recommended" : "not_recommended", sentiment_quote: "",
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
