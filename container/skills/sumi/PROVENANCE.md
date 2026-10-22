# PROVENANCE — vendored sumi skill copy (vendor-and-pin)

This directory is a **deployment copy**, vendored from the sumi repo. Real
files, not symlinks (deploy convention). Edit the canonical source, never a
copy — local edits here are drift and get overwritten on the next sync (the
deploy step diffs the trees and fails loudly on drift; spec-003 §2.3).

| field | value |
|---|---|
| Source repo | `github.com/shrwnsan/sumi` |
| Source path | `skills/sumi/` (`SKILL.md`, `reference/schema.md`, `scripts/sumi-drain.mjs`) |
| Source commit | `178b515` (shrwnsan/sumi HEAD 2026-10-22, tree verified identical) |
| Copied on | 2026-10-22 |
| Taxonomy basis | `internal/taxonomy/taxonomy.go` v1 — embedded as a literal list in `scripts/sumi-drain.mjs`; re-extract on any taxonomy version bump |

**Sync instruction:** re-vendor from the source commit above before every
deploy — copy the three files verbatim, fill in Source commit + Copied on, then
run the deploy-step drift diff across all copies (canonical, fan-outs). A copy
whose Source commit is stale or unfilled must not serve traffic.

**Vendor-and-pin:** each copy is pinned to an exact source commit and moves only
by an explicit re-vendor step. There is no runtime sync, no symlink, no
auto-update — a stale copy is visible in this file, not discovered in prod.
