# MHC AI Visibility Engine 0.1

The full specification is in `docs/SPEC.md`. Re-read it whenever unsure.

Key rules (details in SPEC.md):
- Owner (Bojan) is not a developer: explain decisions in plain language.
- Stop at every CHECKPOINT and wait for confirmation. Never run the full experiment.
- Never hard-code model IDs — they live in `config/engines.json`.
- Tested engines: provider-default temperature, system prompt only "You are a helpful assistant."
- Analyzer never sees ground truth. Raw data is never overwritten or discarded.
- No real API calls in tests. No secrets in logs or reports.
- Stack: Node.js LTS + TypeScript CLI, better-sqlite3, zod, vitest. Keep dependencies minimal.
- Provider verification notes (Checkpoint 1): `docs/PROVIDERS.md`.
