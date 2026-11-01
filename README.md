# BYV AI Protocol SDK

A BYV protocol runtime and Anthropic Messages-compatible gateway for any provider that exposes an OpenAI-compatible Chat Completions API.

BYV sits between an Anthropic Messages client and one configured upstream model:

- Client contract: Anthropic Messages API shape.
- Runtime protocol: BYV markup for model-generated tool calls.
- Upstream contract: OpenAI-compatible Chat Completions.
- Model configuration: one provider endpoint, one API key, and one actual provider model.
- Model catalog: several response profiles that all use that same configured upstream model.

This project does not integrate DeepSeek, Qwen, Playwright, browser automation, or any provider-specific web UI.

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
              | assistant text containing BYV calls
              v
    BYV parser -> typed decoder -> JSON Schema validation
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

| Model ID | Profile intent |
| --- | --- |
| byv-default | Balanced BYV default |
| claude-opus-5-5 | Deliberate, rigorous, deep execution |
| claude-sonnet-5-5 | Balanced speed and practical execution |
| claude-haiku-5-5 | Fast, concise, reliable focused work |
| claude-mythos-5-1 | Defensive security review and threat analysis |
| claude-fable-5.1 | Adaptive long-horizon and multi-step work |

The claude-* values are compatibility profile identifiers only. They do not connect to Anthropic or invoke Anthropic models. They are simply style presets applied to the one configured provider model.

The model profile is selected from the request model field. The upstream request always uses PROVIDER_MODEL.

## Requirements

- Node.js 18 or later.
- An OpenAI-compatible provider that implements POST /v1/chat/completions.
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

All API routes require the gateway key using either Authorization: Bearer <key> or x-api-key: <key>.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | /health | Authenticated health and provider-configuration status |
| GET | /v1/models | Discover available BYV response profiles |
| POST | /v1/messages | Anthropic Messages-compatible request |
| POST | /v1/messages/count_tokens | Local input-size estimate |

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

## Tool calls

The gateway injects the exact tools and input schemas from each request into the BYV system prompt. The model must answer with the BYV format defined in system/BYV_SYSTEM_PROMPT_TEMPLATE_v0.1.txt.

Example:

~~~text
<|BYV| calls>
<|BYV| invoke name="Read" id="call_001">
<|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter>
</|BYV| invoke>
</|BYV| calls>
~~~

The parser turns this into an Anthropic-style content block:

~~~json
{
  "type": "tool_use",
  "id": "call_001",
  "name": "Read",
  "input": {
    "file_path": "README.md"
  }
}
~~~

The invocation ID emitted by the model is preserved. It is used as the tool-call ID when the conversation is converted to the upstream OpenAI-compatible message format, and it is returned unchanged in the Anthropic tool_use block.

The gateway validates:
- Exactly one outer calls block.
- Invocation metadata and attribute ordering.
- Unique, non-empty invocation IDs.
- Unique parameter names.
- Supported BYV parameter types.
- String escaping and strict JSON decoding for non-string parameters.
- Tool names against the request allowlist.
- Every input against its declared JSON Schema.
- tool_choice requirements.

The gateway does not execute the tool. The client executes the requested tool, then sends the assistant tool_use block and a user tool_result block with the matching tool_use_id in the next Messages request. BYV converts those blocks to OpenAI-compatible assistant tool_calls and tool-role messages.

When a batch is malformed or fails schema validation, the gateway makes a bounded recovery request. It does not forward a partial or invalid batch. After the configured recovery limit, it returns an explicit API error rather than pretending the turn completed successfully.

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

The current version is a compatibility layer, not a complete reimplementation of every Anthropic API feature. Image and document blocks, provider-native prompt caching, Anthropic-specific sampling controls not mapped above, and native Anthropic thinking signatures are not implemented.

Input token counts are local estimates. When the upstream returns integer prompt_tokens and completion_tokens, those usage numbers are passed through; otherwise BYV estimates usage using a character-based approximation. /v1/messages/count_tokens is always an estimate, not the provider tokenizer.

## Security and operations

- The server binds to loopback by default.
- Provider credentials and gateway credentials are separate.
- The gateway token is generated locally if GATEWAY_API_KEY is not set.
- Token comparison uses a constant-time byte comparison.
- Host headers are restricted to local loopback hosts.
- CORS is denied by default for browser origins. Exact trusted origins can be listed in CORS_ALLOWED_ORIGINS.
- Request bodies and provider output have configurable size limits.
- Active request concurrency is bounded by MAX_PENDING_REQUESTS.
- Provider requests have a timeout and are cancelled when the client disconnects.
- Logs contain request metadata and error summaries, not raw prompts, API keys, tool arguments, or tool results.

Do not bind this development gateway to a public interface without adding deployment-grade authentication, TLS, rate limiting, monitoring, and network controls.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| PROVIDER_BASE_URL | unset | OpenAI-compatible API base URL or full Chat Completions URL |
| PROVIDER_API_KEY | unset | Upstream provider key; sent as Bearer auth |
| PROVIDER_MODEL | unset | The one actual model ID used by every profile |
| GATEWAY_API_KEY | generated local key | Client-to-BYV authentication key |
| HOST | 127.0.0.1 | Listener host |
| PORT | 8787 | Listener port |
| PROVIDER_TIMEOUT_MS | 300000 | Upstream request and stream timeout |
| MAX_BODY_BYTES | 10485760 | Maximum inbound JSON request body |
| MAX_OUTPUT_CHARS | 2097152 | Maximum provider response size |
| MAX_PROMPT_CHARS | 120000 | Maximum generated system prompt size |
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
