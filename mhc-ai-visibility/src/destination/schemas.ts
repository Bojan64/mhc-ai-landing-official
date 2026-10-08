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

export const BOOKING_TARGETS = ["hotel_site", "ota", "other_link", "none"] as const;
export const LODGING_TYPES = ["hotel", "guesthouse", "apartment", "hostel", "camp", "resort", "other"] as const;

export const AnalyzedHotelSchema = z.strictObject({
  name: z.string().min(1),
  lodging_type: z.enum(LODGING_TYPES),
  recommended: z.boolean(),
  location_stated: z.string().nullable(),
  booking_target: z.enum(BOOKING_TARGETS),
  booking_evidence: z.string().nullable(),
  quote: z.string(),
});
export type AnalyzedHotel = z.infer<typeof AnalyzedHotelSchema>;

export const AnalysisSchema = z.strictObject({
  // In order of first mention in the answer.
  hotels: z.array(AnalyzedHotelSchema),
  no_hotels_reason: z.string().nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
