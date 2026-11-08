# Configuration

Copy `.env.example` to `.env`. Configuration is read at startup.

## Required provider settings

```env
PROVIDER_BASE_URL=https://provider.example/v1
PROVIDER_API_KEY=your-provider-api-key
PROVIDER_MODEL=your-provider-model-id
```

`PROVIDER_BASE_URL` may be the provider root, a `/v1` URL, or the full `/v1/chat/completions` URL. The adapter normalizes it to the Chat Completions endpoint.

## Tool transport

```env
DSML_TOOL_CALL=true
```

Accepted boolean forms are `1/true/yes/on` and `0/false/no/off`.

| Value | Provider-facing transport |
| --- | --- |
| `true` | DeepSeek DSML text protocol |
| `false` | Provider-native function calling |

The default is `true`.

### DSML mode

DSML mode:

- puts tool descriptions and schemas into the model-facing prompt;
- expects DeepSeek DSML calls in assistant text;
- disables upstream native tool execution;
- sends upstream `tool_choice: none`;
- converts DSML to the internal BYV calls representation;
- validates the normalized calls against the declared tool schema.

### Native mode

Native mode:

- sends Anthropic tool schemas as OpenAI-compatible function tools;
- maps Anthropic `tool_choice` to provider-native values;
- accepts provider-native `tool_calls`;
- normalizes provider function arguments into the internal call representation;
- maps names that are not provider-safe to unique aliases on outbound schemas and named `tool_choice`, then restores original names on returned calls;
- skips DSML instructions, DSML parsing, and DSML recovery.

Both modes use the same gateway-side tool validation before returning Anthropic `tool_use`.

## Prompt experiment

```env
NO_TOOL_EXPERIMENT_VARIANT=A
```

This setting is DSML-only. Variant `A` hides tool metadata in the relevant experiment; variant `B` exposes tool names/descriptions as reference-only. Native mode ignores this setting.

## Reasoning compatibility

```env
PROVIDER_NATIVE_REASONING_EFFORT=false
PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS=false
```

Enable `PROVIDER_NATIVE_REASONING_EFFORT` only when the upstream provider supports the `reasoning_effort` parameter.

`PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS` is an explicit compatibility workaround for providers that require `reasoning_effort: none` for required or named native tool choices. BYV does not infer this behavior from provider or model names.

## Gateway

```env
HOST=127.0.0.1
PORT=8787
GATEWAY_API_KEY=
GATEWAY_ALLOWED_HOSTS=
```

If `GATEWAY_API_KEY` is empty, BYV creates `.byv-gateway-token` on first startup and reuses it.

`GATEWAY_ALLOWED_HOSTS` is for additional exact Host values, typically from a trusted reverse proxy. Loopback Host values are accepted automatically for local use. Configure hostnames, not full URLs.

## Provider limits

Optional provider capability settings:

```env
PROVIDER_CONTEXT_WINDOW_TOKENS=
PROVIDER_MAX_INPUT_TOKENS=
PROVIDER_MAX_OUTPUT_TOKENS=
PROVIDER_MODEL_METADATA_TIMEOUT_MS=5000
PROVIDER_CAPABILITIES_CACHE_MS=300000
CONTEXT_WINDOW_SAFETY_TOKENS=1024
```

Explicit token limits override provider-discovered metadata. Leave them blank to allow capability discovery.

## Reliability and request limits

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PROVIDER_TIMEOUT_MS` | 300000 | Upstream request timeout |
| `MAX_PROVIDER_RETRIES` | 1 | Transient provider retry budget |
| `STREAM_PING_INTERVAL_MS` | 15000 | Anthropic streaming ping interval |
| `MAX_BODY_BYTES` | 10485760 | Maximum request body |
| `MAX_OUTPUT_CHARS` | 2097152 | Maximum assembled model output |
| `MAX_PROMPT_CHARS` | 4000000 | Maximum assembled system prompt |
| `MAX_PENDING_REQUESTS` | 8 | Gateway pending-request limit |
| `MAX_RECOVERY_ATTEMPTS` | 2 | Tool-call recovery attempts |

Provider quota controls:

```env
PROVIDER_MAX_REQUESTS_PER_MINUTE=0
PROVIDER_MAX_CONCURRENT_REQUESTS=0
```

A value of `0` disables the corresponding provider quota limiter.

The authenticated gateway API has a separate limit of 30 requests per rolling 60 seconds per client IP.

## Compaction budgets

```env
COMPACTION_MAX_INPUT_TOKENS=32768
COMPACTION_MAX_OUTPUT_TOKENS=8192
COMPACTION_MAX_SYSTEM_CHARS=8000
```

These bound Claude Code autocompaction requests. Provider capability discovery can lower effective budgets when the configured model has smaller limits.

## Diagnostics

```env
LOG_CAPTURE_CONTENT=false
LOG_MAX_FILE_BYTES=10485760
LOG_ROTATION_FILES=3
```

Content capture is off by default. Logs are written as JSONL under `logs/`.

When enabled, BYV attempts to redact provider/gateway keys, common credential fields, and common token formats. Redaction is best-effort, so only enable content capture in a trusted environment.

## Office CORS

For local Claude for Office / Word Desktop integration:

```env
CORS_ALLOWED_ORIGINS=https://pivot.claude.ai
```

Keep `HOST=127.0.0.1` for a local-only gateway unless the deployment architecture explicitly requires otherwise.

## Secret handling

Never commit:

- `.env`
- `.byv-gateway-token`
- provider API keys
- gateway API keys
- diagnostic content containing private data

The repository's `.gitignore` excludes local secrets and logs.
