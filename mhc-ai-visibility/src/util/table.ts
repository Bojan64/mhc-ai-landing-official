/** Render rows as a plain-text table for the terminal. First row is the header. */
export function table(rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map(String));
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join("\n");
}

export const usd = (v: number | null) => (v === null ? "unknown" : `$${v.toFixed(2)}`);
export const eur = (v: number | null) => (v === null ? "unknown" : `€${v.toFixed(2)}`);
