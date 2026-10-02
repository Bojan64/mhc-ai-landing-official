const KEY_PATTERNS = [/sk-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /pplx-[A-Za-z0-9_-]{8,}/g];
const KEY_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"];

/** Remove anything that looks like an API key before text goes to logs, the DB error column, or reports. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const v of KEY_VARS) {
    const key = env[v];
    if (key && key.length >= 8) out = out.split(key).join("[REDACTED]");
  }
  for (const p of KEY_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}
