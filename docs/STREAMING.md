# End-to-end streaming

The live stream=true path translates an OpenAI-compatible provider SSE response into Anthropic Messages SSE events without waiting for the complete assistant response before forwarding ordinary text.

## Data path

~~~text
Anthropic client (Claude Code / SDK)
        |
        | POST /v1/messages { "stream": true }
        v
HTTP lifecycle + Anthropic SSE writer
        |
        | text_delta (await write + drain)
        v
Handler / tool protocol router
        |
        | async event iteration
        v
OpenAI-compatible provider SSE reader
        |
        v
Configured model
~~~

streamChatCompletionEvents() is the live provider API. It incrementally reads the upstream response body and yields normalized events:

| Event | Meaning |
| --- | --- |
| text_delta | New assistant text; forwarded to Anthropic as text_delta after the protocol guard |
| reasoning_delta | Provider reasoning metadata; retained internally and not exposed as ordinary text |
| tool_call_delta | Partial native provider tool-call data, indexed by provider tool-call index |
| usage | Provider usage snapshot |
| finish | Provider choice finish reason |
| completion | Final assembled response, emitted after [DONE] |

createStreamingChatCompletion() remains available as a compatibility collector for callers that need the previous completed-object result.

## Anthropic event lifecycle

For stream=true, the server emits:

1. message_start
2. zero or more ping
3. content_block_start for a text or tool-use block
4. zero or more content_block_delta
5. content_block_stop
6. message_delta with the final stop reason and output usage
7. message_stop

Plain text deltas are written as they arrive. The writer serializes all outgoing SSE writes and waits for drain when ServerResponse.write() reports backpressure. A slow client therefore slows the upstream reader instead of allowing an unbounded queue of future provider chunks to accumulate in the gateway.

## Tool-call safety

Tool calls are intentionally treated differently from plain text.

### Native provider tools

Provider tool_calls deltas are accumulated by index. The completed calls go through the existing native call normalizer, provider-name restoration, request tool allowlist, and JSON Schema validation. Only after the handler returns validated tool calls does the SSE writer emit Anthropic tool_use blocks and input_json_delta fragments.

The gateway never forwards incomplete upstream JSON arguments as a client-visible tool call.

### DSML/BYV text protocol

The incremental DsmlStreamGuard uses a small look-behind for possible opening protocol markers. It releases normal prose immediately, but suppresses DSML/BYV and legacy tool-call wrappers from the user-visible stream. Markdown code examples are masked before marker detection so protocol examples in fenced code blocks are not treated as invocations.

After the provider finishes, the original DSML adapter, BYV parser, tool allowlist, and schema validator remain authoritative. The validated result is converted into Anthropic tool_use blocks. The stream guard is not a second BYV parser and does not replace the canonical validation path.

## Lifecycle and failure behavior

- **Backpressure:** SSE writes are serialized; a false return from res.write() waits for drain.
- **Disconnect:** closing the client response aborts the request AbortController; the provider reader is cancelled and the provider quota slot is released.
- **Timeout:** the upstream request and streaming read retain the configured PROVIDER_TIMEOUT_MS timeout behavior.
- **Retries:** the live stream opens with message_start; transient provider retries are disabled once that client SSE lifecycle has begun. Errors after headers are committed are reported with an Anthropic SSE error event, then the response closes.
- **Output bounds:** streamed text and native tool-call fragments are counted against MAX_OUTPUT_CHARS; the final normalized completion is checked again by the handler.
- **Usage:** estimated input usage is available in message_start; provider output usage is returned in message_delta. The response retains X-Token-Usage-Estimated when the gateway had to estimate usage.
- **Proxy behavior:** response headers include Content-Type: text/event-stream; charset=utf-8, Cache-Control: no-cache, no-transform, and X-Accel-Buffering: no.

## Reverse proxy configuration

For Nginx, disable proxy buffering for the gateway location:

~~~nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
~~~

Any other proxy/CDN in front of the gateway must also be configured not to buffer or transform text/event-stream responses. Network-level buffering outside the Node process can otherwise make a correctly streamed gateway appear buffered to the client.

## Verification

Run:

~~~bash
npm run check
npm test
~~~

The test suite covers upstream provider SSE parsing, early text-delta delivery, native tool-call assembly and validation, DSML marker suppression, Anthropic event serialization, backpressure, and client-disconnect cancellation. npm test executes the complete suite with both DSML_TOOL_CALL=true and DSML_TOOL_CALL=false.

For a real provider/client compatibility check, configure .env, start the gateway, and send an Anthropic Messages request with stream=true using the configured gateway key. The integration smoke scripts remain useful for validating Claude Code and the Anthropic SDK against the live configured provider.
