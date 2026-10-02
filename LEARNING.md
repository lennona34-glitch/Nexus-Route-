# NexusRoute learning prototype

Select `nexus-qwen3-brain:latest` and enable built-in tools. Coding requests now retain memory tools, retrieve up to three relevant lessons, and encourage checking before saving lessons.

Try: "List my saved coding lessons." To correct one: "Update lesson KEY: ..." To remove one: "Delete lesson KEY."

The `learning_memory` tool supports list/save/delete/check. Save requires key, problem, fix, scope and a passed evidence ID; optional sources are HTTP(S) URLs. Source-backed lessons may include `source_records` with `url`, `checkedAt`, and `expiresAt`; listings expose `source_status` as `fresh`, `stale`, or `none`. Save the same key to correct a lesson.

For this first version, checks run Node `.test.js`, `.test.mjs` or `.test.cjs` files. Include the tested source paths in `files`. Checks return an evidence ID, timestamp, test output, and SHA-256 hashes. A saved lesson is `check_passed` only for a successful recorded check whose listed files have not changed. Changed/missing listed files mark it stale. This does not detect changes to unlisted dependencies, environment or tools and does not certify test quality or general correctness. Test processes use the app's existing OS permissions; workspace path validation is not an OS sandbox.

Lessons and checks persist in `.nexus_learning.json` in the selected workspace. Existing `.nexus_memory.json` notes are preserved. Retrieval uses token overlap, limits output to 4500 characters, and labels remembered content as untrusted reference material. No fine-tuning is performed. Saving lessons still depends on the agent choosing the tool. External client-agent mode is unchanged.

Validation: TypeScript check and 13 focused tests pass. All 11 failures in the broader router suite also reproduce against the pre-change source. The experiment script ran local Qwen on a training task with a stated missing-value convention, saved the tested lesson, then tried a related task with and without memory. Without memory: 1/3 tests passed; with memory: 3/3. This single controlled trial demonstrates transfer of information deliberately omitted from the baseline, not a general reasoning improvement. See experiment/results.json for code, timing and full test evidence.

Re-run: `node node_modules/tsx/dist/cli.mjs scripts/learning-experiment.ts`

The 24-task coding benchmark is run with `node node_modules/tsx/dist/cli.mjs scripts/benchmark-suite.ts`. The latest 8B run scored 17/24 without recalled lessons and 19/24 with memory (+2 tasks); the repair pass then reached 24/24, including a targeted 14B repair for query parsing. The new tasks cover query parsing, chunking, object picking, memoization, and byte formatting. Failed recalled tasks can be repaired with `scripts/self-correcting-benchmark.ts`; it writes `benchmark-suite/self-correction-results.json` and a local `benchmark-suite/dashboard.html`. Repairs are promoted only after a passing evidence check.

Maintenance: run `npm run learning:doctor -- --workspace <workspace>` to inspect memory size, duplicate keys, stale evidence, expired source records, and the latest self-correction benchmark. Add `--strict` for CI or scheduled jobs so attention items produce a failing exit code; add `--json` for automation.

Source refresh: run `npm run learning:refresh -- --workspace <workspace> --dry-run` to check recorded URLs without changing memory. Remove `--dry-run` to refresh successful records for 30 days; use `--days N` to choose a 1–365 day window. Failed URLs are left stale and cause a nonzero exit code.
