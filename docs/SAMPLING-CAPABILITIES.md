# Provider sampling capability discovery

BYV accepts Anthropic Messages requests but sends inference to one configured OpenAI-compatible Chat Completions endpoint. Optional sampling fields are not uniformly implemented across compatible providers or models. BYV therefore discovers support for the **configured upstream model**, then filters every request before constructing the provider payload.

The selected BYV response profile does not change `PROVIDER_MODEL`. Each profile contributes its own generation defaults; the provider capability registry decides which of those defaults can actually be sent.

## Discovery order

At server startup, BYV resolves sampling support in this order:

1. **Explicit environment allowlist.** When `PROVIDER_SUPPORTED_SAMPLING_PARAMETERS` is non-empty, it is authoritative. Only listed fields are enabled.
2. **Provider model metadata.** BYV requests the exact model metadata resource and then the model catalog, looking for a `supported_parameters` array. A metadata list is treated as authoritative for listed and unlisted fields.
3. **Active request probes.** When metadata does not publish parameter support and `PROVIDER_SAMPLING_AUTO_PROBE=true`, BYV first sends a minimal baseline Chat Completions request. If the baseline succeeds, it tests optional fields individually using `max_tokens: 1` and `stream: false`.
4. **Unknown / fail closed.** If support cannot be determined, BYV does not add that optional field to provider requests.

The active probe checks: `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `typical_p`, `top_a`, `tfs_z`, `seed`, `mirostat`, `mirostat_tau`, `mirostat_eta`, and `reasoning_effort`. `logit_bias` is not actively probed because token IDs are tokenizer-specific; enable it only through authoritative metadata or the explicit environment allowlist.

A 2xx probe result means the endpoint accepted the request containing that field. It does **not** prove the server applied the setting or that the model's output distribution changed. Some compatible servers silently ignore unknown fields. For those providers, use their metadata or an explicit allowlist, and run quality evaluations if effective behavior matters.

An isolated HTTP 400 or 422 after a successful baseline marks that one field unsupported for the configured endpoint/model. Authentication, quota, rate-limit, timeout, network, and server errors are inconclusive. BYV records those fields as unknown and omits them. If the baseline cannot be completed, no field is guessed as supported.

Active probes may consume a small amount of provider quota. They are run at startup only when a usable `supported_parameters` metadata list and manual allowlist are not available. Probes use a one-token output budget; they do not stream, call tools, or include user conversation data.

## Per-profile generation defaults

The response profiles in `src/model-profiles.js` have independent `generation` objects. Current temperature defaults are BYV tuning recommendations, not official settings for the named profile families or the configured upstream model.

| BYV profile | Default temperature | Intent |
| --- | ---: | --- |
| `byv-flash-v1` | 0.70 | Balanced everyday responses |
| `claude-opus-5-5` | 0.40 | Deliberate high-impact work |
| `claude-sonnet-5-5` | 0.30 | Well-scoped execution and coding |
| `claude-haiku-5-5` | 0.20 | Focused extraction and structured work |
| `claude-mythos-5-1` | 0.10 | Careful security review |
| `claude-fable-5.1` | 0.45 | Multi-step synthesis and deliverables |
| `claude-fable-5-2` | 0.35 | Deep research and long-horizon engineering |
| `claude-mythos-5-2` | 0.10 | Security engineering and threat analysis |
| `claude-opus-5` | 0.25 | Agentic coding and enterprise work |
| `claude-opus-4-8` | 0.20 | Careful coding and reasoning |

Profiles leave `top_p`, `top_k`, and provider-specific sampling values unset by default. This avoids imposing non-portable extensions or needlessly combining multiple sampling controls. Profiles can add their own values later when a known target provider/model benefits from them.

## Request precedence and filtering

For each field, the explicit Anthropic client request overrides the selected BYV profile default. If neither supplies a value, BYV leaves the provider's default unchanged.

Before each upstream completion, BYV filters `temperature`, `top_p`, `top_k`, `reasoning_effort`, and every `provider_params` entry against the detected capability map. Unsupported or unknown fields are removed independently. Supported siblings remain in the request. For example, if only `temperature` and `min_p` are supported, BYV can send those two while omitting `top_k`, `frequency_penalty`, and other unrecognized fields.

The same filtering occurs for streaming, non-streaming, and recovery completions. The gateway records omitted field names and the discovery source in its local structured diagnostics; it does not record parameter values or prompts in that event.

For OpenRouter model metadata, `supported_parameters` is the union across serving endpoints. BYV adds OpenRouter's `provider.require_parameters=true` routing hint so the router selects an endpoint that supports every optional parameter included in the request.

## Inspecting the result

After startup, the console reports discovery source/status and lists supported, unsupported, and unknown parameters. The authenticated endpoint also exposes the snapshot:

```http
GET /v1/provider/capabilities
```

Use `?refresh=1` to refresh provider metadata and sampling discovery. The JSON response contains the existing context/input/output/cache fields plus a `sampling` object:

- `source`: `environment`, `provider_metadata`, `active_probe`, or `unknown`;
- `status`: discovery state;
- `parameters`: per-field `true`, `false`, or `null` (unknown);
- `supported_parameters`, `unsupported_parameters`, and `unknown_parameters`;
- `checked_at`: discovery timestamp.

## Environment controls

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROVIDER_SAMPLING_AUTO_PROBE` | `true` | Run active parameter probes when provider metadata does not publish a support list |
| `PROVIDER_SAMPLING_PROBE_TIMEOUT_MS` | `15000` | Timeout for each small baseline/parameter probe |
| `PROVIDER_SUPPORTED_SAMPLING_PARAMETERS` | empty | Optional comma-separated authoritative allowlist, e.g. `temperature,top_p,min_p` |
| `PROVIDER_CAPABILITIES_CACHE_MS` | `300000` | Cache duration for discovered capabilities |
| `PROVIDER_NATIVE_REASONING_EFFORT` | `true` | Forward `reasoning_effort` only after capability discovery accepts it; set false to disable explicitly |

Set `PROVIDER_SAMPLING_AUTO_PROBE=false` to avoid inference probes. If there is no metadata list or explicit allowlist, optional parameters remain unknown and are omitted. Use the environment allowlist only when the provider documentation or a controlled test confirms those fields are accepted.

## Scope and limitations

- Detection is bound to `PROVIDER_BASE_URL` and `PROVIDER_MODEL` at process startup. A provider route that changes its underlying model or serving endpoint can change capabilities; refresh or restart after changing provider configuration.
- OpenAI-compatible APIs do not define a universal endpoint for per-parameter capabilities. Standard `GET /models` responses often expose model IDs and basic metadata only.
- A parameter can be accepted at the API boundary yet ignored by the server, clamped by a router, or ineffective for a particular inference mode. The capability map reports acceptance evidence, not guaranteed semantic effect.
- Parameter value ranges and interactions remain subject to BYV request validation and upstream model behavior. Detection of a field name does not validate every possible value.
- The capability map does not create native tool-calling, multimodal, or reasoning support. Those remain separate provider/model capabilities.
