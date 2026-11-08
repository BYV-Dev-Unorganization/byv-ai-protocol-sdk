# Architecture

BYV AI Protocol SDK is a local or self-hosted gateway that exposes an Anthropic Messages-compatible HTTP contract while using one configured OpenAI-compatible upstream model.

## Request flow

```text
Anthropic client
      |
      | POST /v1/messages
      v
HTTP server
      |
      +-- authentication / Host / Origin checks
      +-- request normalization and validation
      +-- model-profile selection
      +-- request-intent detection
      |
      v
Message handler
      |
      +-- tool transport selection
      |      |
      |      +-- DSML text mode
      |      |     prompt -> provider text -> DSML adapter -> BYV parser
      |      |
      |      +-- native mode
      |            Anthropic tools -> provider function tools
      |            provider tool_calls -> normalized BYV calls
      |
      +-- JSON Schema validation
      +-- bounded recovery / retry
      |
      v
OpenAI-compatible provider adapter
      |
      | POST /v1/chat/completions
      v
Configured upstream model
      |
      v
Anthropic response / tool_use / SSE
```

## Core boundaries

### Anthropic contract

The gateway accepts Anthropic Messages requests, validates message/content blocks, normalizes compatible input, maps `tool_choice`, and returns Anthropic message envelopes or SSE events.

The gateway owns the client-facing contract. The upstream provider does not need to understand Anthropic's API.

### Provider adapter

The provider adapter translates the normalized gateway request into the configured OpenAI-compatible Chat Completions payload.

The configured provider is selected by:

- `PROVIDER_BASE_URL`
- `PROVIDER_API_KEY`
- `PROVIDER_MODEL`

Only one actual upstream model is configured. The IDs exposed by `GET /v1/models` are BYV response profiles, not additional upstream models.

### Tool transport

`DSML_TOOL_CALL` is the single provider-facing tool transport switch.

When true, tools are represented in model-facing text using DeepSeek DSML. The gateway disables upstream native tool execution, requests `tool_choice: none`, converts DSML into the internal BYV calls representation, then uses the existing parser and JSON Schema validation.

When false, the gateway sends provider-native function schemas and mapped `tool_choice` values. Returned provider `tool_calls` are normalized directly. DSML instructions, parsing, and DSML recovery are not used.

Both paths converge on the same gateway-side tool allowlist and schema validation before an Anthropic `tool_use` response is produced.

### Tool execution boundary

The gateway does not execute client tools.

A successful tool call is returned to the Anthropic client as `tool_use`. The client or agent runtime is responsible for executing the requested tool and sending the result back in a later request.

## Request-scoped controls

The server determines the effective transport mode from `DSML_TOOL_CALL`. Tests can override the same behavior through explicit handler/server options.

Request intent is also detected for special flows such as Claude Code compaction and the Claude Desktop connection probe. These flows can alter the effective provider request without changing ordinary user requests.

## Streaming

For streaming requests, BYV converts the upstream provider SSE stream into the Anthropic SSE contract. It emits the Anthropic `message_start` event early and sends periodic `ping` events while waiting for provider output.

Provider tool-call deltas are accumulated by tool-call index and finalized before normalization.

## Recovery

Malformed or schema-invalid tool calls can enter bounded recovery. Recovery prompts are protocol-specific:

- DSML mode uses DSML repair instructions.
- Native mode rejects invalid provider-native calls without injecting DSML instructions.

The recovery limit is controlled by `MAX_RECOVERY_ATTEMPTS`.

## Model profiles

The model profile selected in the Anthropic request changes response-style guidance only. It does not change the configured upstream model.

The canonical default is `byv-flash-v1`; compatibility aliases and additional profile IDs are defined in `src/model-profiles.js`.

## Main source modules

| Module | Responsibility |
| --- | --- |
| `src/server.js` | HTTP routing, auth, CORS, rate limiting, request intent |
| `src/handler.js` | Main inference flow, tool-call normalization, recovery |
| `src/prompts.js` | System prompts, tool instructions, DSML/native prompt behavior |
| `src/provider/openai-compatible.js` | Upstream request/response and SSE transport |
| `src/provider/tool-calls.js` | Native function schema/tool-choice mapping and normalization |
| `src/protocol/dsml-adapter.js` | DSML-to-BYV normalization |
| `src/protocol/parser.js` | Internal BYV calls parser |
| `src/tools/validator.js` | Tool allowlist and JSON Schema validation |
| `src/config.js` | Environment configuration and gateway token handling |
| `src/diagnostics.js` | Structured local JSONL diagnostics |

## Security boundary

The gateway authenticates client requests with a gateway token. Provider credentials are separate and are only used for upstream requests.

Request bodies and logs have explicit size/content-capture controls. Content capture is disabled by default.

The gateway should normally bind to loopback for local desktop integrations. If deployed behind a trusted reverse proxy, configure exact allowed Host values and explicit CORS origins as appropriate.
