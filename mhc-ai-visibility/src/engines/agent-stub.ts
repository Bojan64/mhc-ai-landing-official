/**
 * AGENT BOOKING TEST — planned, NOT implemented in 0.1 (see docs/SPEC.md §15).
 *
 * Idea: give an agentic assistant (one that can browse and act) the task
 * "Book 2 nights at {hotel_name}" and record where it goes to book:
 * the hotel's own website (direct) or an OTA / metasearch site.
 *
 * Planned output per test: first booking domain visited, final booking domain,
 * classification (direct / ota / metasearch / other), steps taken, screenshots.
 * The agent must stop before entering any payment or personal data.
 */
export interface AgentBookingResult {
  hotel_id: string;
  engine_id: string;
  first_booking_domain: string | null;
  final_booking_domain: string | null;
  channel: "direct" | "ota" | "metasearch" | "other" | "none";
}

export function runAgentBookingTest(): never {
  throw new Error("Agent booking test is not implemented in version 0.1.");
}
