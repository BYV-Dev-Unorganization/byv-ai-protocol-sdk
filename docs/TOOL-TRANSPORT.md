# Tool Transport

BYV supports two provider-facing tool transport modes behind one switch.

## Mode matrix

| | `DSML_TOOL_CALL=true` | `DSML_TOOL_CALL=false` |
| --- | --- | --- |
| Model-facing protocol | DeepSeek DSML text | Provider-native function calling |
| Provider `tools` | Not sent | Sent as native function tools |
| Provider `tool_choice` | `none` | Mapped from Anthropic choice |
| Tool instructions in prompt | Yes | No DSML tool instructions |
| DSML parser | Used | Not used |
| DSML recovery | Used | Not used |
| Gateway schema validation | Yes | Yes |
| Anthropic output | `tool_use` | `tool_use` |

The default is DSML mode.

## DSML mode

With DSML enabled, the model receives the declared tools and complete JSON Schemas in the model-facing prompt.

A canonical call looks like:

```text
<｜DSML｜ calls>
<｜DSML｜ invoke name="Read">
<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>
```

The DSML adapter converts this model output into BYV text markup. The existing BYV parser parses that markup and returns canonical in-memory tool-call objects. This BYV text conversion and parsing step exists only in DSML mode.

The adapter also:

- creates invocation IDs;
- converts DSML string flags into typed BYV values;
- preserves escaped string content;
- supports multiple calls in one wrapper;
- rejects malformed or ambiguous DSML before tool execution.

### DSML constraints

The gateway expects one outer calls block and one invoke block per call. Parameter names must match the declared schema. String parameters use `string="true"`; non-string values use `string="false"` and one valid JSON value.

DSML examples inside Markdown code spans/fenced code are masked so they are not interpreted as actual tool calls.

## Native mode

With DSML disabled, the gateway translates Anthropic tools into OpenAI-compatible function tools:

```json
{
  "type": "function",
  "function": {
    "name": "Read",
    "description": "...",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

Anthropic tool-choice values are mapped as follows:

| Anthropic | Provider-native |
| --- | --- |
| `none` | `none` |
| `auto` | `auto` |
| `any` | `required` |
| `required` | `required` |
| specific tool | `{ type: "function", function: { name } }` |

Provider-native function calls are handled directly as structured JSON. The OpenAI-compatible provider returns `function.arguments` as a JSON string; BYV decodes that string into a JavaScript object with `JSON.parse()` and constructs the canonical in-memory object:

```js
[
  {
    id: "call_provider_123",
    name: "Read",
    input: {
      file_path: "README.md"
    }
  }
]
```

This canonical tool-call object is an internal data structure, not BYV markup and not a separate protocol. Native mode does not call the DSML adapter or the BYV text parser. There is no JSON-to-BYV-markup-to-JSON round trip.

Provider tool names must match `[A-Za-z0-9_-]{1,64}`.

## Validation

Regardless of transport, a tool call must:

1. refer to a declared tool;
2. contain an object-shaped argument payload;
3. have valid arguments (DSML typed values in DSML mode, JSON-decoded arguments in native mode);
4. satisfy the declared JSON Schema;
5. respect gateway tool-call limits and duplicate-ID checks.

Only then can the gateway return Anthropic `tool_use`.

## Recovery

Recovery is bounded by `MAX_RECOVERY_ATTEMPTS`.

DSML recovery explains the expected DSML protocol and asks the model to rebuild a valid call. Native mode uses provider-native validation/recovery behavior and does not inject DSML instructions.

A repeated invalid call can eventually become an explicit gateway error rather than an unbounded retry loop.

## Tool execution

The gateway never executes a tool itself.

The lifecycle is:

```text
model -> tool_use response -> client/agent executes tool
     -> client sends tool_result -> gateway -> model
```

This distinction is important for security and for understanding why a successful gateway tool call does not imply that a filesystem or shell action has already happened.
