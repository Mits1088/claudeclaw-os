# Outbound sanitization acceptance for v1.10

Baseline: main `8f11afa`, including retained sanitization after #280 and the #281 attachment fix. This reconciles #269 with implemented code; the issue's claim that no shared boundary exists is stale.

| Requirement | Retained implementation and evidence |
| --- | --- |
| Shared policy, idempotency, opt-out, detector failure | `outbound-sanitizer.ts`; `outbound-sanitizer.test.ts` covers patterns, protected raw/base64 values, overlaps, false positives, idempotency, disabled mode and suppression. |
| Arbitrary stream boundaries | `OutboundStreamGuard` buffers until completion, with a 256 Ki-character ceiling. Stream tests cover splits, abort, overflow and revised accumulated snapshots. Enabled and disabled modes retain the ceiling. |
| Provider output | `agent.ts` guards accumulated callbacks and final/aborted text; all engines use this shared boundary. Voice subprocess tests exercise result, error and abort with a synthetic engine. Separate live Claude/Codex SDK/App Server acceptance remains required. |
| Telegram, Signal, Mattermost | Transport and messenger-handler tests capture synthetic API/JSON output. Telegram transformer covers sends, edits and captions. |
| Attachment compatibility | #281 preserves non-plain objects, including InputFile and Buffer. Payload/file tests capture multipart content and sanitized captions. File bytes are intentionally outside text inspection. |
| Browser output | Dashboard tests capture actual SSE bytes, including direct event producers; presentation serialization scans visible fields. |
| Stored results | Persistence tests inspect mission result/error, assistant conversation and scheduled result rows. Transport tests also cover War Room emission and transcript/conversation storage. Delegation persistence calls the shared helper. |
| Voice and War Room | Voice subprocess stdout and War Room provider/transport tests capture sanitized serialized text. Real speech service availability is a separate acceptance check. |
| Progress and tool previews | Presentation-field policy plus argument serialization scans before preview truncation/escaping; preview tests cover arbitrary argument keys and values. |
| Configured file-only credentials | Demonstrated gap: policy previously read only process.env, although readEnvFile deliberately does not export credentials. This change reads configured protected names from the same .env reader, with nonempty process values taking precedence. Policy tests cover raw, base64, URL encoding and serialized output. |

## Remaining limits and release checks

- This is a text boundary, not full DLP or process/network containment. Attachment bytes and direct tool network traffic remain outside scope.
- Only configured protected names and detector patterns are covered. Values of eight characters or fewer are excluded by existing policy.
- Presentation serialization scans its explicit field inventory, not every arbitrary application property. New adapters need boundary review.
- Aborted provider output is sanitized when returned; pending incremental output can be discarded on abort/error. No promise of partial-output delivery.
- General application diagnostics are not comprehensively sanitized: for example, agent.ts logs original provider error messages. Sanitizer diagnostics themselves contain only categories/counts. A blanket claim that all logs are protected would be incorrect.
- Do not close #269 solely from helper tests. Actual runtime crew/provider acceptance and review of the residual diagnostics scope remain open.
