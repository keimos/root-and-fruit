# specs/ — lightweight, spec-first feature notes

Before building a non-trivial feature, write a short spec here from
[`TEMPLATE.md`](TEMPLATE.md). The point isn't ceremony — it's to make **one
deliberate pass over the project's hard constraints** (single-file frontend, the
locked prompt, the scoring invariants) *before* writing code, so a change
doesn't quietly break one of them.

A spec that's longer than the change it describes is a smell. Keep them short.

## Workflow

1. Copy `TEMPLATE.md` → `specs/NNNN-short-slug.md` (next number, zero-padded,
   e.g. `0001-electability-csv-export.md`).
2. Fill it in — especially **§3 Guardrails** and **§5 Acceptance criteria**.
3. Implement with Claude Code **plan mode**, using the spec as the brief
   ("plan against `specs/NNNN-*.md`").
4. Ship via the normal dev-first pipeline (CLAUDE.md → Deployment). If §3 marks
   the **locked prompt**, the Billion Godson regression is mandatory.
5. Flip the spec's **Status** to `Shipped` (or `Superseded`, linking the
   replacement) when done.

## When to skip a spec

Typo/copy fixes, dependency bumps, and pure-infra chores don't need one. When in
doubt for **anything touching scoring, the locked prompt, or the audit flow** —
write the spec.

A spec is a record, not a contract in stone: if the approach changes mid-build,
update the spec so it still describes what actually shipped.
