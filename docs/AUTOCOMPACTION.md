# Claude Code Autocompaction

This document describes the current implementation in BYV AI Protocol SDK. It is a technical companion to the [root README](../README.md), not a claim that the gateway maintains a persistent provider-side conversation session.

## 1. Purpose and request contract

The gateway accepts Anthropic Messages-compatible requests and sends inference requests through a stateless OpenAI-compatible Chat Completions interface. A stateless upstream does not provide the persistent browser/thread state used by some web interfaces. For Claude Code autocompaction, BYV therefore creates a bounded replay of the conversation instead of forwarding the entire unbounded Anthropic history unchanged.

Autocompaction is a special summary turn. It is text-only: the summary request must not invoke tools, even when Claude Code includes its normal tool catalog in the request.

## 2. How a request is recognized

The classifier in `src/request-intent.js` examines the **latest message only**. It accepts either a string content value or text blocks in an array, then requires all three categories below (matching is case-insensitive):

1. A prohibition on tools, matching wording such as `do not call any tools` or `do not use … any other tool`.
2. A plain-text-only requirement, matching wording such as `respond with plain text only` or `output only plain text`.
3. Both `<analysis>` and `<summary>` tags, plus a summary/conversation-related word.

The checks are intentionally more specific than detecting the word “compact”. An instruction that does not contain the expected signals may be handled as a normal request. Conversely, changing the upstream provider or model name does not change the classifier.

The detection result is recorded as `request_intent: "claude_code_compaction"` in request diagnostics.

## 3. Provider payload construction

When the detector matches:

1. BYV forces the gateway-level tool choice to `none` for this request.
2. The compaction system prompt is built with an empty tool list and native tool calling disabled.
3. Historical messages are rendered into a readable text transcript. Assistant and user turns are labeled `[ASSISTANT]` and `[USER]`; previous tool activity is context, not an executable tool request.
4. The upstream payload contains two messages: one `system` message and one `user` message containing the ordered transcript.
5. The transcript builder prioritizes the first user task, recent turns, and the latest compaction instruction. When it cannot retain all history, it inserts explicit omission markers and truncates oversized sections while preserving their beginning/end where possible.

This is a bounded replay, not a byte-for-byte replay of the original Anthropic message array. It does not attach provider-native tool schemas to the summary request and does not branch on a provider/model identifier.

## 4. Input and output budget calculation

The generic defaults are:

| Variable | Default | Accepted range | Purpose |
| --- | ---: | ---: | --- |
| `COMPACTION_MAX_INPUT_TOKENS` | `32768` | 1,024–1,000,000 | Upper bound for the provider-shaped summary input |
| `COMPACTION_MAX_OUTPUT_TOKENS` | `8192` | 256–200,000 | Upper bound for summary output |
| `COMPACTION_MAX_SYSTEM_CHARS` | `8000` | 1,024–100,000 | Maximum external system/developer instruction characters retained in the compaction system prompt |

The final budget is reduced when more specific provider limits are available:

- **Output:** the minimum of the generic compaction output limit, the client's requested `max_tokens`, and a discovered/overridden provider maximum output. When a context window is known, output is additionally capped at 25% of the context remaining after the configured safety reserve.
- **Input:** the minimum of the generic compaction input limit and a discovered/overridden provider maximum input. When a context window is known, input is also limited to the context remaining after the selected output budget and safety reserve.
- **System instructions:** external system/developer text is bounded separately by `COMPACTION_MAX_SYSTEM_CHARS`; BYV's own required prompt/profile content remains part of the resulting system message and must still fit the overall input budget.

Provider capability metadata is best-effort. OpenAI-compatible APIs do not standardize context metadata, so configure `PROVIDER_CONTEXT_WINDOW_TOKENS`, `PROVIDER_MAX_INPUT_TOKENS`, and/or `PROVIDER_MAX_OUTPUT_TOKENS` when the upstream does not publish reliable limits. Explicit environment values override discovered values. The gateway does not infer limits from provider or model names.

### Token estimation

The transcript builder first uses a character budget to reduce the candidate history. BYV then estimates the provider-shaped message array with its shared `estimateProviderInputTokens()` helper and iteratively shrinks the transcript until the estimate is within the computed input budget.

This is BYV's local estimate, not the upstream provider's exact tokenizer count. The character-to-token ratio is a sizing heuristic, not a promise about tokenization.

### Token-count endpoint

`POST /v1/messages/count_tokens` uses the same compaction detector, provider capability limits, max-output adjustment, and compaction message builder. Therefore its estimate reflects the bounded payload intended for the actual compaction request rather than the ordinary full-history request layout. The response is marked with `X-Token-Usage-Estimated: true`.

## 5. Configuration related to model limits

| Variable | Default | Notes |
| --- | ---: | --- |
| `PROVIDER_CONTEXT_WINDOW_TOKENS` | unset | Explicit total context-window limit; overrides discovered metadata |
| `PROVIDER_MAX_INPUT_TOKENS` | unset | Explicit provider input limit; overrides discovered metadata |
| `PROVIDER_MAX_OUTPUT_TOKENS` | unset | Explicit provider output limit; overrides discovered metadata |
| `CONTEXT_WINDOW_SAFETY_TOKENS` | `1024` | Reserved context budget for formatting and estimate variance |
| `PROVIDER_MODEL_METADATA_TIMEOUT_MS` | `5000` | Timeout for metadata discovery |
| `PROVIDER_CAPABILITIES_CACHE_MS` | `300000` | Cache duration for detected capabilities |

For the full configuration inventory, see the Configuration section in the root README and the `.env.example` file.

## 6. Diagnostics

Use the request ID returned in `X-Gateway-Request-ID` to correlate events. For compaction requests, structured diagnostics include fields such as:

- `request_intent` — `claude_code_compaction` or `normal`.
- `compaction_max_input_tokens` — computed input-token ceiling for the request.
- `compaction_max_output_tokens` — computed output-token ceiling.
- Message/tool counts and the normal provider attempt/phase metadata.

Content logging is disabled by default. Enabling `LOG_CAPTURE_CONTENT=true` may write prompts, source code, command output, and tool results to local logs; use it only for trusted local debugging and disable it afterwards. Redaction is best-effort.

## 7. Budget-related failures

A compaction request can fail before upstream inference when its required prompt cannot fit the available budget:

| Error code | Meaning |
| --- | --- |
| `PROVIDER_COMPACTION_BUDGET_UNAVAILABLE` | Detected/configured provider limits leave no valid positive input/output budget |
| `PROVIDER_COMPACTION_SYSTEM_PROMPT_EXCEEDS_BUDGET` | Required BYV system/profile content alone exceeds the input budget |
| `PROVIDER_COMPACTION_INPUT_BUDGET_EXCEEDED` | The transcript cannot be reduced below the computed input-token ceiling |

The appropriate response is to review the actual upstream limits and the three compaction budget settings. Raising the generic budget beyond the model's true capability does not make the request fit; provider limits still take precedence.

## 8. Verification and operational limits

Relevant regression coverage is in:

- `test/request-intent.test.js` — compaction request classification.
- `test/prompts.test.js` — transcript preservation and input-budget behavior.
- `test/handler.test.js` — compaction budgets, text-only provider payload, and diagnostics.
- `test/server.test.js` — shared behavior for the token-count route.

Run the automated checks with:

```sh
npm test
npm run check
```

The automated suite uses controlled fixtures/mocks; it does not by itself prove live compatibility with every OpenAI-compatible provider. The repository's opt-in client/provider smoke tests are separate and may consume provider quota.

Current limitations:

- The upstream API remains stateless; BYV reconstructs a bounded summary context rather than resuming a persistent upstream thread.
- History reduction is intentionally lossy when a request exceeds its budget. Omission markers indicate removed sections but cannot preserve every detail.
- The detector relies on the latest instruction's wording. An unusual compaction prompt may not match the current signatures and should be checked through diagnostics.
- Local token estimates can differ from provider billing/tokenizer counts.
- The broader streaming implementation validates/buffers provider output before emitting final content; it is not token-by-token upstream passthrough.
