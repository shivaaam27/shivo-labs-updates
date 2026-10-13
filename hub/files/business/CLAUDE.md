# Shivo Labs Business (our own ERP)

**Read `business/DONE.md` before any work here, and follow it exactly.** Shivam's rule (13 Oct 2026): when he gives a
phase, everything ERPNext has in that part is built or written down with its phase; nothing is left out silently and
nothing only looks like it works. The gate is code (`node --test "business/**/*.test.ts"`, also run by the pre-commit
hook): never weaken a test, an answer form or a check to make it pass, and never mark something `=` that does not
really work. If the gate cannot pass, say so plainly instead of committing around it (no `--no-verify`).

Other rules: build from `pos/blueprint/` only, never from ERPNext code (clean room); the ERPNext test site is only a
referee (`business/referee`). Contract: `business/FRAME.md`. Tests and data: see the map in the root `CLAUDE.md`.
