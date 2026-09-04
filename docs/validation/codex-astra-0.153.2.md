# GPT-6 Astra readiness on Codex 0.153.2

Date: 2026-09-04 MDT  
Host: native Windows 10.0.26200, x64  
Runtime: `@openai/codex` and `@openai/codex-sdk` 0.153.2

OpenAI's [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) and [migration guidance](https://developers.openai.com/api/docs/guides/latest-model) define the compatibility contract used here:

- model id `gpt-6-astra`;
- Responses API for tool calling;
- reasoning efforts `low`, `medium`, `high`, `xhigh`, and `max`, with no `none`;
- no `temperature`, `top_p`, or `top_logprobs`;
- 1,050,000-token context window;
- API list pricing of $10/M input, $1/M cached input, and $50/M output.

ClaudeClaw does not construct the Responses API request directly. Both native transports delegate it to the pinned Codex runtime, so the application-side changes are the exact runtime uplift, model/effort catalog, and local telemetry metadata.

| Gate | Result |
|---|---|
| `@openai/codex` exact pin | Pass, 0.153.2 |
| `@openai/codex-sdk` exact pin | Pass, 0.153.2 |
| Generated App Server protocol audit | Pass, 150 checks |
| TypeScript typecheck | Pass |
| Production build | Pass |
| Full unit suite | Pass, 2,203 passed and 16 skipped |
| Generated CLI documentation check | Pass |
| Native model catalog and dashboard labels | Pass, `gpt-6-astra` selectable |
| Telegram shortcut | Pass, `/model astra` |
| Astra `none` reasoning effort | Pass, rejected locally by both transports |
| Astra supported efforts | Pass, `low` through `max` |
| Pricing metadata | Pass, $10 / $1 cached / $50 per million tokens |
| Context metadata | Pass, 1,050,000 tokens |
| SDK adapter smoke | Wiring passed; account rollout blocked the model request |
| App Server adapter smoke | Wiring and effective-policy verification passed; account rollout blocked the model request |
| Native-Windows containment | Partial pass; cancellation remains blocked upstream |

The subscription-auth smoke tests reached the upstream API through both adapters. App Server reported effective model `gpt-6-astra`, reasoning effort `low`, approval policy `never`, read-only sandbox, network disabled, and no instruction/profile widening. Both then received the same upstream availability response:

```text
The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.
```

No API key was configured on this host, so API-key execution could not be exercised. This is an account rollout gate, not a ClaudeClaw routing or schema failure. Both adapters translate that upstream JSON into an actionable rollout/API-key message. Re-run the two smoke paths when Astra reaches the account or with an Astra-enabled scoped API key.

The separate [native-Windows 0.153.2 containment evidence](codex-native-windows-0.153.2.md) shows that sandboxed process-tree cancellation is still unavailable. Keep `CODEX_TRANSPORT=sdk` as the default and rollback path; App Server remains opt-in.
