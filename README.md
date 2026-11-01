# BYV AI Protocol SDK

A BYV protocol runtime and Anthropic Messages-compatible gateway for any provider that exposes an OpenAI-compatible Chat Completions API.

BYV sits between an Anthropic Messages client and one configured upstream model:

- Client contract: Anthropic Messages API shape.
- Tool transport: BYV Format Block in assistant text by default; provider-native function calling is an explicit optional mode.
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
              +-- BYV system prompt + per-request tool schemas
              +-- conversation conversion
              +-- OpenAI-compatible provider adapter
              |
              v
    One configured OpenAI-compatible model
              |
              | assistant text containing BYV Format Block
              v
    BYV parser -> typed arguments -> JSON Schema validation
              |
              +-- optional native function-call adapter
              |
              +-- bounded recovery when malformed
              |
              v
    Anthropic message / tool_use / SSE response

Tool execution is intentionally outside the protocol parser and gateway. A tool_use response asks the client or agent runtime to execute a tool. The gateway does not execute a shell command or access client files merely because the model emitted a BYV invocation.

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
- An OpenAI-compatible provider that implements POST /v1/chat/completions. Native function calling is recommended for agent clients; providers without it can use the BYV markup fallback.
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
# Optional only. BYV Format Block is the default.
PROVIDER_NATIVE_TOOL_CALLING=false
~~~

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

BYV Format Block is the default tool-call protocol. The gateway places the request's tool allowlist, descriptions, and JSON Schemas in the BYV system prompt. The upstream model returns a structured block in its assistant text, and BYV parses and validates that block before translating accepted invocations into Anthropic Messages `tool_use` blocks.

Example model output:

~~~text
<|BYV| calls>
<|BYV| invoke name="Read" id="call_001">
<|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter>
</|BYV| invoke>
</|BYV| calls>
~~~

The Anthropic `tool_choice` setting is enforced through the gateway's runtime prompt overlay and post-generation validation:
- `auto`: the model may call an available tool when needed;
- `any`: the model must emit at least one valid BYV invocation;
- `none`: the model must return text and must not emit a tool invocation;
- a specific tool: the model must emit an invocation for that exact tool.

The provider adapter does not send OpenAI-compatible `tools` or `tool_choice` fields in the default BYV mode. This means the configured model does not need native provider function-calling support. It only needs to follow the BYV Format Block instructions in ordinary Chat Completions text.

### Optional provider-native function calling

Set `PROVIDER_NATIVE_TOOL_CALLING=true` only when you explicitly want to test or use the upstream provider's native function-calling interface. In that mode, BYV forwards the tool schemas and mapped `tool_choice` to the provider, then normalizes returned native calls into the same validated gateway call representation.

For DeepSeek Chat Completions models in this optional mode, the adapter sets `reasoning_effort: "none"` on forced-tool requests. This is separate from the default BYV Format Block path.

Both modes converge on the same allowlist and JSON Schema validation before BYV returns Anthropic `tool_use`. Malformed or schema-invalid batches go through bounded protocol recovery. BYV never forwards a partial or invalid batch.

The gateway does not execute tools. The client executes the requested tool, then sends the assistant `tool_use` block and a user `tool_result` block with the matching `tool_use_id` in the next Messages request. BYV serializes this prior tool history into the configured provider's chat conversation format. This history conversion does not change the current assistant output protocol: BYV Format Block remains the default.

## Streaming

Set stream: true on /v1/messages to receive Anthropic-style SSE events:

- message_start
- content_block_start
- content_block_delta
- content_block_stop
- message_delta
- message_stop
- error on a gateway failure after SSE begins

The upstream provider is requested with stream: true. BYV currently buffers the upstream stream until the complete response has been parsed and validated, then emits the Anthropic SSE sequence. This ensures that malformed or schema-invalid tool batches are never partially forwarded. It preserves the SSE event contract but does not yet provide token-by-token latency from the upstream model.

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

### Provider capabilities and context budgeting

BYV performs best-effort model metadata discovery using the configured provider's OpenAI-compatible model endpoints: GET /models/{model}, then GET /models when the detail endpoint does not expose limits. It recognizes reported context-window, maximum-input, and maximum-output token fields. Model capability metadata is cached for PROVIDER_CAPABILITIES_CACHE_MS and can be refreshed with GET /v1/provider/capabilities?refresh=1. The endpoint reports the actual configured provider model and the source of each detected limit.

OpenAI-compatible APIs do not standardize context-window metadata. When the provider does not publish a limit in its model metadata, set PROVIDER_CONTEXT_WINDOW_TOKENS, PROVIDER_MAX_INPUT_TOKENS, and/or PROVIDER_MAX_OUTPUT_TOKENS explicitly. Explicit environment values override discovered values. BYV never infers a context window from the model name. An unknown limit remains unknown rather than being guessed.

Before each upstream completion, including a recovery attempt, BYV estimates the provider-shaped input payload. The estimate includes the BYV system prompt, current tool schemas, client system instructions, converted conversation history, and tool results. When the provider's context/input/output limits are known, BYV rejects a request that cannot fit the input plus requested max_tokens and CONTEXT_WINDOW_SAFETY_TOKENS. It does not silently truncate or compact conversation history, and it does not quietly lower max_tokens. If limits are unknown, the regular body and system-prompt size limits still apply.

`MAX_PROMPT_CHARS` is a character-based safety ceiling for the assembled system prompt only; it is not a token limit or a substitute for provider context budgeting. The default is 4,000,000 characters and the configurable range is 8,192–8,000,000 characters. The complete provider-shaped input is still subject to the discovered or explicitly configured provider token limits.

These local counts are conservative estimates, not counts from the provider's exact tokenizer. /v1/messages/count_tokens returns the provider-shaped input estimate and is always marked X-Token-Usage-Estimated: true. Actual prompt_tokens and completion_tokens from the provider take precedence in Messages usage.

### Provider prompt caching and usage

When the upstream provider supports automatic prompt/prefix caching, BYV sends ordinary Chat Completions messages and lets the provider manage its inference cache. BYV keeps the invariant core system prompt at the beginning of the assembled prompt and appends request-specific tool definitions, client instructions, profile guidance, effort, and tool-choice overlays afterward. This gives the provider the longest stable prefix available across requests. BYV does not inject Anthropic cache_control or other provider-specific cache parameters into a generic OpenAI-compatible payload.

When the provider reports cache usage, BYV maps prompt_tokens_details.cached_tokens (and recognized cache-creation/cache-read fields) into the Anthropic usage fields cache_read_input_tokens and cache_creation_input_tokens. The uncached portion is reported as input_tokens. Cache counts are omitted when the provider does not report them; BYV does not manufacture cache-hit metrics.

## Security and operations

- The server binds to loopback by default.
- Provider credentials and gateway credentials are separate.
- The gateway token is generated locally if GATEWAY_API_KEY is not set.
- Token comparison uses a constant-time byte comparison.
- Host headers are restricted to local loopback hosts.
- CORS is denied by default for browser origins. Exact trusted origins can be listed in CORS_ALLOWED_ORIGINS.
- Request bodies and provider output have configurable size limits.
- Active request concurrency is bounded by MAX_PENDING_REQUESTS.
- Authenticated API traffic is limited to 30 requests per rolling 60 seconds per client IP. The server uses the socket peer address and does not trust client-supplied forwarded-IP headers.
- Provider requests have a timeout and are cancelled when the client disconnects.
- Outbound inference requests can be paced globally by provider requests-per-minute and maximum concurrent-request settings. The limiter includes normal, recovery, and streaming completions; health checks and local token counting do not consume provider quota.
- Logs contain request metadata and error summaries, not raw prompts, API keys, tool arguments, or tool results.

Do not bind this development gateway to a public interface without adding deployment-grade authentication, TLS, rate limiting, monitoring, and network controls.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| PROVIDER_BASE_URL | unset | OpenAI-compatible API base URL or full Chat Completions URL |
| PROVIDER_API_KEY | unset | Upstream provider key; sent as Bearer auth |
| PROVIDER_MODEL | unset | The one actual model ID used by every profile |
| PROVIDER_NATIVE_TOOL_CALLING | false | Optional upstream native function calling; BYV Format Block is the default tool-call protocol |
| GATEWAY_API_KEY | generated local key | Client-to-BYV authentication key |
| HOST | 127.0.0.1 | Listener host |
| PORT | 8787 | Listener port |
| PROVIDER_TIMEOUT_MS | 300000 | Upstream completion and stream timeout |
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
| CORS_ALLOWED_ORIGINS | empty | Exact comma-separated browser origins to allow |

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
