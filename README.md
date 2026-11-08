# BYV AI Protocol SDK

A BYV protocol runtime and Anthropic Messages-compatible gateway for any provider that exposes an OpenAI-compatible Chat Completions API.

BYV sits between an Anthropic Messages client and one configured upstream model:

- Client contract: Anthropic Messages API shape.
- Model-facing tool transport: DeepSeek DSML in assistant text by default; a gateway adapter converts it to the internal BYV representation before parsing and validation. Provider-native function calling is an explicit optional mode.
- Upstream contract: OpenAI-compatible Chat Completions API. Native function tools are not required.
- Model configuration: one provider endpoint, one API key, and one actual provider model.
- Model catalog: several response profiles that all use that same configured upstream model.

## Architecture

    Anthropic-compatible client
              |
              | POST /v1/messages
              v
    BYV gateway and Anthropic contract
              |
              +-- request validation / content normalization
              +-- profile selection
              +-- DSML model instructions + per-request tool schemas
              +-- conversation conversion
              +-- OpenAI-compatible provider adapter
              |
              v
    One configured OpenAI-compatible model
              |
              | assistant text containing DeepSeek DSML
              v
    DSML adapter -> BYV parser -> typed arguments -> JSON Schema validation
              |
              +-- optional native function-call adapter
              |
              +-- bounded recovery when malformed
              |
              v
    Anthropic message / tool_use / SSE response

Tool execution is intentionally outside the protocol parser and gateway. A tool_use response asks the client or agent runtime to execute a tool. The gateway does not execute a shell command or access client files merely because the model emitted a DSML invocation.

## One upstream model, multiple response profiles

Configure one actual upstream model:

~~~env
PROVIDER_BASE_URL=https://provider.example/v1
PROVIDER_API_KEY=your-provider-api-key
PROVIDER_MODEL=your-provider-model-id
~~~

Every ID returned by GET /v1/models resolves to a response profile. All profiles use the same upstream endpoint, key, and model. Profiles add response-style and work-habit instructions; they do not change model weights or grant Anthropic-native capabilities.

Included profiles:

| Model ID | Display name | Profile intent |
| --- | --- | --- |
| byv-flash-v1 | BYV Flash V1 | Balanced, practical default |
| claude-opus-5-5 | Opus 5.5 | Deliberate, rigorous, deep execution |
| claude-sonnet-5-5 | Sonnet 5.5 | Balanced speed and practical execution |
| claude-haiku-5-5 | Haiku 5.5 | Fast, concise, reliable focused work |
| claude-mythos-5-1 | Mythos 5.1 | Defensive security review and threat analysis |
| claude-fable-5.1 | Fable 5.1 | Adaptive long-horizon and multi-step work |

The previous `byv-default` ID remains accepted as a compatibility alias for `byv-flash-v1`, but only `byv-flash-v1` is listed in the model catalog.

The `claude-*` values are compatibility profile identifiers only. They do not connect to Anthropic or invoke Anthropic models. They are simply style presets applied to the one configured provider model.

The model profile is selected from the request model field. The upstream request always uses PROVIDER_MODEL.

## Requirements

- Node.js 18 or later.
- An OpenAI-compatible provider that implements POST /v1/chat/completions. Native function calling is recommended for agent clients; providers without it can use the DSML text-output fallback.
- A provider API key, when required by that provider.

## Setup

Install dependencies:

~~~sh
npm install
~~~

Copy .env.example to .env and set the provider values:

~~~env
PROVIDER_BASE_URL=https://your-provider-host/v1
PROVIDER_API_KEY=your-secret-key
PROVIDER_MODEL=provider-model-id
# Tool transport: true = DSML text protocol, false = provider-native function calling.
DSML_TOOL_CALL=true
PROVIDER_NATIVE_REASONING_EFFORT=true
~~~

With `DSML_TOOL_CALL=true`, the gateway disables provider-native tools, sets the upstream provider `tool_choice` to `none`, and uses DeepSeek DSML text instructions/parser/recovery. With `DSML_TOOL_CALL=false`, the gateway sends native OpenAI-compatible tool schemas and mapped `tool_choice`, normalizes provider `tool_calls`, and does not parse or recover DSML. Both modes use the same BYV tool allowlist and JSON Schema validation before returning Anthropic `tool_use`.

The base URL may end in /v1 or be the full /v1/chat/completions URL. The adapter appends /v1/chat/completions when the URL does not already include it.

Start the gateway:

~~~sh
npm start
~~~

By default it listens on http://127.0.0.1:8787.

On first startup, BYV generates a separate gateway client key and stores it in .byv-gateway-token. This key is not the provider key. Keep both secrets private and never commit them.

PowerShell:

~~~powershell
$env:ANTHROPIC_AUTH_TOKEN = (Get-Content -Raw .byv-gateway-token).Trim()
~~~

Git Bash:

~~~bash
export ANTHROPIC_AUTH_TOKEN="$(tr -d '\r\n' < .byv-gateway-token)"
~~~

If GATEWAY_API_KEY is set in the environment, that value is used instead of the local token file.

## API endpoints

All application API routes require the gateway key using either Authorization: Bearer <key> or x-api-key: <key>. The Claude Code connection-warming probe at HEAD /api/hello is intentionally unauthenticated.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| HEAD | /api/hello | Unauthenticated connection-warming probe for Claude Code |
| GET | /health | Authenticated health and provider-configuration status |
| GET | /v1/models | Discover available BYV response profiles |
| GET | /v1/provider/capabilities | Inspect detected upstream context/input/output/cache capabilities |
| POST | /v1/messages | Anthropic Messages-compatible request |
| POST | /v1/messages/count_tokens | Local input-size estimate |

Authenticated API requests are limited to **30 requests per rolling 60 seconds per client IP**. The limit applies across authenticated endpoints and returns HTTP 429 with a `Retry-After` header when exceeded. The unauthenticated `HEAD /api/hello` probe and CORS `OPTIONS` preflight requests are excluded.

## Claude for Microsoft 365 / Claude for Office

### Local Word Desktop connection

For Claude for Office running inside the installed Word desktop app on the same computer as BYV, use the local gateway directly. No Cloudflare Tunnel, ngrok, public domain, or `npm run start:office` launcher is needed.

Keep the gateway bound to loopback in `.env`:

```env
HOST=127.0.0.1
PORT=8787
GATEWAY_ALLOWED_HOSTS=
CORS_ALLOWED_ORIGINS=https://pivot.claude.ai
```

Loopback Host headers (`127.0.0.1`, `localhost`, and `::1` on the configured local port) are accepted automatically by BYV, so do not put a URL such as `http://127.0.0.1:8787` in `GATEWAY_ALLOWED_HOSTS`. That setting is only for additional exact Host header values from a trusted reverse proxy; values must be hostnames, not URLs.

Start BYV from the repository directory:

```powershell
npm start
```

In Claude for Office, configure:

| Setting | Value |
| --- | --- |
| Gateway URL | `http://127.0.0.1:8787` |
| API format | `anthropic` |
| Auth header | `x-api-key` or `Authorization: Bearer`, matching the selected authentication scheme |
| API key | The gateway token from `.byv-gateway-token` |

Use the URL as the base URL; do not append `/v1/messages`. Keep the BYV process running while using the add-in. This local URL is for the installed Office desktop app on the same computer; it is not a public endpoint for browser-only clients or other computers.

A bootstrap endpoint is not required when users enter a static gateway URL and token in the add-in. Configure `bootstrap_url` only when you need to deliver per-user settings or rotate gateway tokens automatically.

## Claude Desktop (Third-Party Inference) gateway

BYV supports Claude Desktop's Gateway provider through the Anthropic Messages contract: authenticated `GET /v1/models` and `POST /v1/messages`. The model catalog lists BYV response profiles locally; a successful model-list request does not by itself verify that the upstream provider can generate a completion.

Claude Desktop's gateway connection check uses a small non-streaming inference probe (`max_tokens: 1` with one user message containing `.`). Some reasoning-oriented OpenAI-compatible providers consume that one-token budget internally and return an empty visible completion. BYV recognizes this exact probe shape and raises the upstream provider-side output budget to 512 tokens for the probe only. Ordinary user requests retain their requested `max_tokens` unchanged.

For real streaming inference, BYV sends an Anthropic `message_start`, an immediate SSE `ping`, and periodic pings at `STREAM_PING_INTERVAL_MS` (15 seconds by default) while waiting for the provider. Claude Desktop's `inferenceStreamIdleTimeoutSec` setting controls additional waiting when a stream continues to send pings without model output; it does not affect the non-streaming connection probe. See the [Claude Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration#inferencestreamidletimeoutsec) and the [observed one-token gateway probe](https://github.com/anthropics/claude-code/issues/103731).

## Local diagnostics logs

The gateway writes structured JSON Lines files to the local `logs/` directory. Each event includes an ISO timestamp and, when associated with a message request, the same `request_id` returned in the `X-Gateway-Request-ID` response header.

| File | Contents |
| --- | --- |
| `requests.jsonl` | Incoming request metadata and each upstream provider attempt |
| `responses.jsonl` | Completed upstream provider responses and normalized gateway responses |
| `errors.jsonl` | Provider, transport, request-validation, parser, and tool-call failures/rejections |
| `timeline.jsonl` | Unified chronological event stream for correlation |

Content capture is **off by default**. Metadata logs include model/profile, message and tool counts, tool names, estimated input tokens, provider attempt number and phase, response sizes, token usage, durations, and error codes. Prompt text, tool arguments, tool results, and model response text are omitted.

To explicitly capture request and response content for local debugging, set:

```env
LOG_CAPTURE_CONTENT=true
```

When enabled, the logger redacts configured provider/gateway API keys, common credential fields, and several common token formats. Redaction is best-effort, not a guarantee: prompts, source code, command output, and tool results may still contain private information. Enable this only in a trusted local environment, inspect the files before sharing them, and turn it off when debugging is complete.

Each JSONL file is limited to 10 MiB by default and keeps three rotated backups. Override with `LOG_MAX_FILE_BYTES` and `LOG_ROTATION_FILES`. The entire `logs/` directory is excluded from Git.

Example request:

~~~sh
curl http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-5-5",
    "max_tokens": 512,
    "messages": [
      { "role": "user", "content": "Explain what BYV does." }
    ]
  }'
~~~

The response follows the Anthropic message envelope with id, type, role, model, content, stop_reason, stop_sequence, and usage.

## Using the Anthropic SDK

Install the client:

~~~sh
npm install @anthropic-ai/sdk
~~~

Example:

~~~js
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');

const client = new Anthropic({
  apiKey: fs.readFileSync('.byv-gateway-token', 'utf8').trim(),
  baseURL: 'http://127.0.0.1:8787'
});

async function main() {
  const response = await client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'Hello from BYV.' }]
  });
  console.log(response);
}

main().catch(console.error);
~~~

The SDK appends /v1/messages; do not include /v1 in the baseURL.

## Live client compatibility smoke tests

The repository includes opt-in live smoke tests for provider and client compatibility. They call the configured upstream provider and/or the running BYV gateway, so they are not part of `npm test` or the GitHub Actions unit-test job. They may consume provider quota.

Install dependencies (the Anthropic SDK is included as a development dependency):

~~~sh
npm install
~~~

Start BYV in one terminal:

~~~sh
npm start
~~~

The smoke scripts use `http://127.0.0.1:8787` and read `.byv-gateway-token` automatically for the default local gateway. For a different endpoint or token, set `BYV_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (or `GATEWAY_API_KEY`) in the test terminal. The base URL is the gateway root, without `/v1`; the scripts also normalize a trailing `/v1`.

### Anthropic SDK smoke test

In a second terminal, run:

~~~sh
npm run test:sdk
~~~

This uses the official `@anthropic-ai/sdk` and checks:

- A normal non-streaming Messages request.
- The SDK `messages.countTokens()` call against BYV's local estimate endpoint.
- A text SSE stream parsed by the SDK.
- A non-streaming `tool_use` request and stateless `tool_result` round trip.
- A streamed `tool_use` block, including accumulated `input_json_delta` fragments.

The tool fixture requests a harmless echo command, but the smoke test **never executes it**. It sends a synthetic tool result back to verify the Anthropic conversation contract.

Optional environment variables: `BYV_BASE_URL`, `ANTHROPIC_MODEL` (defaults to `byv-flash-v1`), and `ANTHROPIC_SDK_TEST_TIMEOUT_MS` (defaults to 600000).

### Native provider function-calling smoke test

Run:

~~~sh
npm run test:provider-tools
~~~

This sends one live OpenAI-compatible Chat Completions request with a synthetic `Read` function and `tool_choice: auto`. It passes only when the configured provider returns one structured function call for `README.md`. The tool is never executed and no client files are read. This is the quickest way to isolate provider-native function calling from Claude Code's permissions and local tool runner.

The script uses `PROVIDER_BASE_URL`, `PROVIDER_API_KEY`, and `PROVIDER_MODEL` from `.env`. It may consume provider quota and does not print the API key.

### Claude Code CLI smoke test

Install and authenticate Claude Code CLI separately, make sure the `claude` command is available on `PATH`, then run:

~~~sh
npm run test:claude-code
~~~

The script launches Claude Code in non-interactive `stream-json` mode against the BYV gateway. It requires Claude Code to use these six tools sequentially and wait for each result:

1. `Read` — inspect a fixture `package.json`.
2. `Glob` — find fixture text files.
3. `Grep` — find a known marker.
4. `Edit` — modify a fixture file.
5. `Write` — create a fixture file.
6. `Bash(pwd)` — run only the `pwd` command.

The test creates an isolated temporary workspace, applies a narrow tool/permission allowlist, verifies tool results and the Edit/Write changes, and removes the workspace afterward. It does not grant arbitrary shell execution and does not modify the repository. It tests client-to-gateway tool orchestration; the gateway itself does not execute client tools.

Optional environment variables: `BYV_BASE_URL`, `BYV_CLAUDE_CODE_MODEL` (defaults to `claude-sonnet-5-5`), and `CLAUDE_CODE_TEST_TIMEOUT_MS` (defaults to 600000). The test model is intentionally independent from `ANTHROPIC_MODEL` so a value left over from the Anthropic SDK smoke test cannot change this test. For the local gateway, the script validates the gateway token and model profile before launching Claude Code, and runs the CLI in restricted mode with the six-tool allowlist.

These live integration tests are intentionally separate from:

~~~sh
npm test
npm run check
~~~

The regular suite remains deterministic and does not require a running provider, a gateway token, the Anthropic SDK runtime, or Claude Code CLI.

## Tool calls

When `DSML_TOOL_CALL=true` (the default), the model-facing text protocol is DeepSeek DSML. The gateway places the request's tool allowlist, descriptions, and JSON Schemas in the system prompt and asks the upstream model to return a DSML calls block in assistant text.

Example model output:

~~~text
<｜DSML｜ calls>
<｜DSML｜ invoke name="Read">
<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>
~~~

The DSML adapter converts this model output into the internal BYV representation. It generates unique invocation IDs, maps DSML `string="true"` and `string="false"` parameters to BYV's typed parameter values, and preserves string content through BYV escaping. The adapter then passes the converted text to the existing BYV parser. The parser itself is not changed and remains the single parser responsible for the normalized calls. All calls still pass the same declared-tool allowlist and JSON Schema validation before the gateway returns Anthropic Messages `tool_use` blocks.

In the default text-protocol path, provider-native function calling is disabled while the gateway preserves Anthropic `tool_choice` semantics. For ordinary requests with declared schemas and `auto`/`any`/specific-tool choice, BYV accepts textual DSML output, converts it to the internal BYV representation, validates it, and returns Anthropic `tool_use`. An explicit `tool_choice: none`, a repeated tool loop, or a request without tool schemas disables gateway-level tool calls. Claude Code compaction is recognized as a special text-only summary turn when the latest instruction forbids tool use, requires plain text, and requests the `<analysis>`/`<summary>` structure. This behavior is part of the current SDK implementation, not a branch-specific feature.

The Anthropic `tool_choice` setting is enforced through the gateway's runtime prompt overlay and post-generation validation:
- `auto`: the model may call an available tool when needed;
- `any`: the model must emit at least one valid DSML invocation;
- `none`: the model must return text and must not emit a tool invocation;
- a specific tool: the model must emit an invocation for that exact tool.

The provider adapter sends neither native OpenAI-compatible `tools` definitions nor `tool_choice` in default DSML mode. The gateway describes callable tools in the prompt, parses textual DSML, and enforces the client allowlist locally. This avoids requiring provider-native function-calling support or an unnecessary provider-specific tool-choice parameter.

### Tool transport modes

`DSML_TOOL_CALL` is the single provider-facing tool transport switch:

- `true` / `on`: DSML text mode. Native provider tools are off and upstream `tool_choice` is `none`. DSML instructions, parsing, and DSML recovery are enabled.
- `false` / `off`: native mode. Provider-native schemas and mapped `tool_choice` are sent upstream. Provider-native `tool_calls` are normalized directly; DSML instructions, parser, and DSML recovery are skipped.

The default is `true` to preserve the existing DSML behavior. `NO_TOOL_EXPERIMENT_VARIANT` remains a DSML-only prompt experiment: `A` hides tool metadata and `B` exposes tool names/descriptions as reference-only. It is ignored by native mode.

Some providers require reasoning to be disabled for required or named native tool choices. Set `PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS=true` only when that provider supports `reasoning_effort: "none"` and requires this behavior. The adapter does not infer this capability from a provider or model name.

Both modes converge on the same allowlist and JSON Schema validation before BYV returns Anthropic `tool_use`. Malformed or schema-invalid batches go through bounded protocol recovery. Malformed DSML is converted into malformed internal BYV so the unchanged parser can reject it and trigger recovery. BYV never forwards a partial or invalid batch.

The gateway does not execute tools. The client executes the requested tool, then sends the assistant `tool_use` block and a user `tool_result` block with the matching `tool_use_id` in the next Messages request. BYV serializes this prior tool history into the configured provider's chat conversation format. This history conversion does not change the current model-facing output protocol: DSML is requested by default and normalized to BYV before parsing.

### Claude Code autocompaction over the stateless API

OpenAI-compatible Chat Completions is a stateless request contract, so this gateway cannot reuse a hidden browser-side conversation thread. For Claude Code autocompaction, BYV instead builds a bounded replay containing a system prompt and one ordered user transcript. Historical assistant tool requests and tool results are rendered as text context; no provider-native tools or tool schemas are attached to the summary request.

The replay preserves the original user task, recent conversation turns, and the latest compaction instruction. Oversized external system/developer instructions and older or oversized history are compacted with explicit omission markers. The budget is model-neutral and reduced further when provider model metadata reports smaller input, output, or context limits. It does not branch on provider names or model IDs.

Defaults are COMPACTION_MAX_INPUT_TOKENS=32768, COMPACTION_MAX_OUTPUT_TOKENS=8192, and COMPACTION_MAX_SYSTEM_CHARS=8000. Provider metadata can reduce these limits; environment values can lower the generic budgets for providers whose model metadata is unavailable or incomplete.

See [Autocompaction implementation notes](docs/AUTOCOMPACTION.md) for request detection, payload construction, budget calculation, diagnostics, failure codes, and operational limits.

## Streaming

Set stream: true on /v1/messages to receive Anthropic-style SSE events:

- message_start (sent immediately with estimated input-token usage)
- ping (periodic keep-alive while validated provider output is pending)
- content_block_start
- content_block_delta
- content_block_stop
- message_delta
- message_stop
- error on a gateway failure after SSE begins

The upstream provider is requested with `stream: true`. BYV opens the Anthropic SSE response immediately with `message_start` (using an estimated input-token count), then emits a `ping` and repeats it every `STREAM_PING_INTERVAL_MS` (default 15 seconds) while inference runs. It still buffers provider output until DSML conversion, parsing, allowlist checks, and JSON Schema validation finish; only then are content blocks emitted. The `X-Token-Usage-Estimated: true` response header marks the early input-token estimate. This prevents partial or unvalidated tool batches from reaching Claude Code and keeps the HTTP stream alive, but does not yet provide token-by-token model output. Provider streams that end without `[DONE]` are rejected as incomplete rather than accepted as partial completions.

## Supported request fields and current limitations

The gateway validates and supports the core fields used by the Anthropic Messages contract:

- model
- system
- messages with text, tool_use, and tool_result blocks
- max_tokens
- stream
- tools and input_schema
- tool_choice: auto, any, none, or a specific tool
- temperature
- top_p
- stop_sequences
- output_config.effort: low, medium, high, xhigh, max

The current version is a compatibility layer, not a complete reimplementation of every Anthropic API feature. Image and document blocks, provider-specific cache-control request parameters, Anthropic-specific sampling controls not mapped above, and native Anthropic thinking signatures are not implemented.

### Native reasoning effort

When `PROVIDER_NATIVE_REASONING_EFFORT=true`, BYV forwards Anthropic `output_config.effort` as the top-level provider `reasoning_effort` parameter. This non-standard extension is disabled by default for compatibility. Effort is request metadata, not system-prompt text; requests that omit it leave the provider's model default unchanged. Enable `PROVIDER_NATIVE_REASONING_EFFORT` only when the configured provider supports this parameter. Providers may clamp levels that their configured model does not support. For example, NaraRouter documents clamping unsupported levels, and Meta does not support `max` on `muse-spark-1.3-contributor` (the router may therefore reduce it to the model's highest supported level). Native effort behavior and available levels remain provider/model-specific.

### Provider capabilities and context budgeting

BYV performs best-effort model metadata discovery using the configured provider's OpenAI-compatible model endpoints: GET /models/{model}, then GET /models when the detail endpoint does not expose limits. It recognizes reported context-window, maximum-input, and maximum-output token fields. Model capability metadata is cached for PROVIDER_CAPABILITIES_CACHE_MS and can be refreshed with GET /v1/provider/capabilities?refresh=1. The endpoint reports the actual configured provider model and the source of each detected limit.

OpenAI-compatible APIs do not standardize context-window metadata. When the provider does not publish a limit in its model metadata, set PROVIDER_CONTEXT_WINDOW_TOKENS, PROVIDER_MAX_INPUT_TOKENS, and/or PROVIDER_MAX_OUTPUT_TOKENS explicitly. Explicit environment values override discovered values. BYV never infers a context window from the model name. An unknown limit remains unknown rather than being guessed.

Before each upstream completion, including a recovery attempt, BYV estimates the provider-shaped input payload. The estimate includes the DSML system prompt, current tool schemas, client system instructions, converted conversation history, and tool results. When the provider's context/input/output limits are known, BYV rejects a request that cannot fit the input plus requested max_tokens and CONTEXT_WINDOW_SAFETY_TOKENS. It does not silently truncate or compact conversation history, and it does not quietly lower max_tokens. If limits are unknown, the regular body and system-prompt size limits still apply.

`MAX_PROMPT_CHARS` is a character-based safety ceiling for the assembled system prompt only; it is not a token limit or a substitute for provider context budgeting. The default is 4,000,000 characters and the configurable range is 8,192–8,000,000 characters. The complete provider-shaped input is still subject to the discovered or explicitly configured provider token limits.

These local counts are conservative estimates, not counts from the provider's exact tokenizer. /v1/messages/count_tokens returns the provider-shaped input estimate and is always marked X-Token-Usage-Estimated: true. Actual prompt_tokens and completion_tokens from the provider take precedence in Messages usage.

### Provider prompt caching and usage

When the upstream provider supports automatic prompt/prefix caching, BYV sends ordinary Chat Completions messages and lets the provider manage its inference cache. BYV keeps the invariant core system prompt at the beginning of the assembled prompt and appends request-specific tool definitions, client instructions, profile guidance, and tool-choice overlays afterward. Native reasoning effort is sent separately as a top-level provider parameter, so it does not alter the reusable prompt prefix. This gives the provider the longest stable prefix available across requests. BYV does not inject Anthropic cache_control or other provider-specific cache parameters into a generic OpenAI-compatible payload.

When the provider reports cache usage, BYV maps prompt_tokens_details.cached_tokens (and recognized cache-creation/cache-read fields) into the Anthropic usage fields cache_read_input_tokens and cache_creation_input_tokens. The uncached portion is reported as input_tokens. Cache counts are omitted when the provider does not report them; BYV does not manufacture cache-hit metrics.

## Security and operations

- The server binds to loopback by default.
- Provider credentials and gateway credentials are separate.
- The gateway token is generated locally if GATEWAY_API_KEY is not set.
- Token comparison uses a constant-time byte comparison.
- Host headers are restricted to local loopback hosts unless an exact reverse-proxy hostname is added to GATEWAY_ALLOWED_HOSTS.
- CORS is denied by default for browser origins. Exact trusted origins can be listed in CORS_ALLOWED_ORIGINS.
- Request bodies and provider output have configurable size limits.
- Active request concurrency is bounded by MAX_PENDING_REQUESTS.
- Authenticated API traffic is limited to 30 requests per rolling 60 seconds per client IP. The server uses the socket peer address and does not trust client-supplied forwarded-IP headers.
- Provider requests have a timeout and are cancelled when the client disconnects.
- Outbound inference requests can be paced globally by provider requests-per-minute and maximum concurrent-request settings. The limiter includes normal, recovery, and streaming completions; health checks and local token counting do not consume provider quota.
- Logs contain request metadata and error summaries, not raw prompts, API keys, tool arguments, or tool results.
- Structured per-tool-call events record the request ID, invocation ID, tool name, transport, recovery phase, and validation status/reason. They never include argument values, file paths, file contents, or tool results.

Do not bind this development gateway to a public interface without adding deployment-grade authentication, TLS, rate limiting, monitoring, and network controls.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| PROVIDER_BASE_URL | unset | OpenAI-compatible API base URL or full Chat Completions URL |
| PROVIDER_API_KEY | unset | Upstream provider key; sent as Bearer auth |
| PROVIDER_MODEL | unset | The one actual model ID used by every profile |
| DSML_TOOL_CALL | true | `true`/`on` = DSML text transport; `false`/`off` = provider-native function calling |
| NO_TOOL_EXPERIMENT_VARIANT | A | `A` hides tool metadata; `B` lists tool names/descriptions as reference-only |
| PROVIDER_NATIVE_REASONING_EFFORT | false | Optional provider extension for forwarding Anthropic output_config.effort as native reasoning_effort |
| PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS | false | Send reasoning_effort=none for required/named native tools when the provider explicitly requires it |
| COMPACTION_MAX_INPUT_TOKENS | 32768 | Generic maximum input-token budget for autocompaction, reduced by detected provider limits |
| COMPACTION_MAX_OUTPUT_TOKENS | 8192 | Generic maximum output-token budget for autocompaction, reduced by detected provider limits |
| COMPACTION_MAX_SYSTEM_CHARS | 8000 | Maximum external system/developer instruction characters retained during autocompaction |
| GATEWAY_API_KEY | generated local key | Client-to-BYV authentication key |
| HOST | 127.0.0.1 | Listener host |
| PORT | 8787 | Listener port |
| PROVIDER_TIMEOUT_MS | 300000 | Upstream completion and stream timeout |
| MAX_PROVIDER_RETRIES | 1 | Bounded retries for transient transport/5xx errors; client disconnects and context overflow are not retried |
| STREAM_PING_INTERVAL_MS | 15000 | Anthropic SSE keep-alive ping interval while inference is pending |
| PROVIDER_MAX_REQUESTS_PER_MINUTE | 0 (disabled) | Maximum outbound inference requests in a rolling 60-second window; 0 disables this limit |
| PROVIDER_MAX_CONCURRENT_REQUESTS | 0 (disabled) | Maximum simultaneous outbound inference requests; 0 disables this limit |
| PROVIDER_CONTEXT_WINDOW_TOKENS | unset | Optional exact total context-window override; takes precedence over provider metadata |
| PROVIDER_MAX_INPUT_TOKENS | unset | Optional exact model input-token limit override |
| PROVIDER_MAX_OUTPUT_TOKENS | unset | Optional exact model output-token limit override |
| PROVIDER_MODEL_METADATA_TIMEOUT_MS | 5000 | Timeout for optional provider model-metadata discovery |
| PROVIDER_CAPABILITIES_CACHE_MS | 300000 | How long detected model capabilities are cached |
| CONTEXT_WINDOW_SAFETY_TOKENS | 1024 | Context tokens reserved for formatting and estimation variance |
| MAX_BODY_BYTES | 10485760 | Maximum inbound JSON request body |
| MAX_OUTPUT_CHARS | 2097152 | Maximum provider response size |
| MAX_PROMPT_CHARS | 4000000 | Maximum generated system prompt size in characters (configurable up to 8000000) |
| MAX_PENDING_REQUESTS | 8 | Maximum concurrent gateway requests |
| MAX_RECOVERY_ATTEMPTS | 2 | Maximum tool-call or text-only recovery attempts |
| GATEWAY_ALLOWED_HOSTS | empty | Exact comma-separated Host header values accepted from a trusted reverse proxy; include the port if the proxy sends one |
| CORS_ALLOWED_ORIGINS | empty | Exact comma-separated browser origins to allow |

## Additional documentation

See [`docs/README.md`](docs/README.md) for the documentation index, including current implementation notes, historical integration tests, audit snapshots, and proposals.

## Development

Run tests:

~~~sh
npm test
~~~

Check JavaScript syntax:

~~~sh
npm run check
~~~

The GitHub Actions workflow runs the test suite and syntax checks on pushes and pull requests to main.
