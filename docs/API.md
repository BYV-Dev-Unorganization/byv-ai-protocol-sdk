# API Reference

BYV exposes an Anthropic Messages-compatible surface plus a small set of gateway endpoints.

## Authentication

Authenticated routes accept either:

```http
Authorization: Bearer <gateway-key>
```

or:

```http
x-api-key: <gateway-key>
```

The `HEAD /api/hello` Claude Code connection-warming probe is intentionally unauthenticated.

## Endpoints

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| HEAD | `/api/hello` | No | Claude Code connection-warming probe |
| GET | `/health` | Yes | Gateway/provider configuration health |
| GET | `/v1/models` | Yes | List BYV response profiles |
| GET | `/v1/provider/capabilities` | Yes | Report discovered/configured provider capabilities |
| POST | `/v1/messages` | Yes | Anthropic Messages-compatible inference |
| POST | `/v1/messages/count_tokens` | Yes | Local input-size estimate |

Authenticated application requests are limited to 30 requests per rolling 60 seconds per client IP.

## Messages

The primary route is:

```http
POST /v1/messages
Content-Type: application/json
Authorization: Bearer <gateway-key>
anthropic-version: 2023-06-01
```

The request follows the Anthropic Messages request shape accepted by the gateway.

Important fields include:

- `model`: a BYV response-profile ID, not necessarily the upstream model ID;
- `messages`: Anthropic conversation messages;
- `max_tokens`: requested output budget;
- `stream`: enables Anthropic SSE;
- `tools`: optional declared tool schemas;
- `tool_choice`: `auto`, `any`, `none`, or a specific tool.

The configured upstream model remains `PROVIDER_MODEL` regardless of the requested BYV profile.

## Model discovery

`GET /v1/models` returns the local BYV profile catalog. The profile IDs are compatibility/style profiles over the one configured provider model.

Do not treat a profile ID such as `claude-sonnet-5-5` as evidence that BYV is calling Anthropic. It is a BYV compatibility profile.

## Provider capabilities

`GET /v1/provider/capabilities` exposes detected context, input, output, and cache capabilities for the configured upstream model.

Use `?refresh=1` to force a metadata refresh.

## Count tokens

`POST /v1/messages/count_tokens` performs a local provider-shaped input-size estimate. It does not require an upstream completion.

## Streaming

Set:

```json
{ "stream": true }
```

BYV returns Anthropic SSE events. The gateway starts the stream early and emits periodic pings while waiting for upstream model output.

## Tool responses

When a valid tool invocation is produced, BYV returns Anthropic `tool_use` blocks with normalized invocation IDs and validated input.

The gateway does not execute the tool. The client executes it and sends a `tool_result` in the next conversation turn.

## Errors

Errors use the Anthropic-style JSON error envelope with HTTP status and a gateway/provider error code where applicable.

Common categories include:

- `401`: invalid gateway credentials;
- `403`: disallowed browser Origin;
- `404`: unknown endpoint;
- `413`: request body too large;
- `421`: disallowed Host;
- `429`: gateway rate limit;
- `502/503/504`: upstream/provider or gateway availability failures.

Provider context-window rejections are classified separately so clients can distinguish them from generic upstream failures.
