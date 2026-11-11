'use strict';

const {
  MAX_RECOVERY_ATTEMPTS,
  MAX_PROVIDER_RETRIES,
  MAX_OUTPUT_CHARS,
  CONTEXT_WINDOW_SAFETY_TOKENS,
  COMPACTION_MAX_INPUT_TOKENS,
  COMPACTION_MAX_OUTPUT_TOKENS,
  DSML_TOOL_CALL,
  PROVIDER_MODEL,
  PROVIDER_NATIVE_TOOL_FALLBACK_TO_DSML,
  uuid
} = require('./config');
const { buildProviderMessages, buildCompactionProviderMessages, buildRecoveryMessage } = require('./prompts');
const { createChatCompletion, createStreamingChatCompletion, streamChatCompletionEvents } = require('./provider/openai-compatible');
const { parseBYVOutput } = require('./protocol/parser');
const { convertDsmlToBYV } = require('./protocol/dsml-adapter');
const { validateToolCalls } = require('./tools/validator');
const { blocksOf, estimateProviderInputTokens, estimateOutputTokens } = require('./content');
const { getModelCapabilities } = require('./provider/capabilities');
const { normalizeProviderToolCalls, createProviderToolNameMap, restoreProviderToolCallNames } = require('./provider/tool-calls');
const { maskMarkdownCode } = require('./protocol/markdown-code');
const { modelProfileGeneration } = require('./model-profiles');
const { getSamplingCapabilities, filterSamplingOptions } = require('./provider/sampling-capabilities');
const { isClaudeCodeCompactionRequest } = require('./request-intent');
const TEXT_ONLY_TOOL_CALL_MARKER = /(?:<\|(?:BYV|DSML)\||<｜DSML｜|<\/?TOOL_CALL\b|["'](?:tool_calls|function_call)["']\s*:)/i;

function parseToolChoice(choice) {
  if (!choice) return { mode: 'auto' };
  if (typeof choice === 'string') return { mode: choice };
  if (choice.type === 'tool') return { mode: 'tool', name: choice.name };
  return { mode: choice.type || 'auto' };
}

function validateChoice(calls, force) {
  if (force.mode === 'tool') {
    const wrong = calls.find((call) => call.name !== force.name);
    if (wrong) {
      return { valid: false, error: 'tool_choice requires ' + force.name + ', but the model returned ' + wrong.name + '.' };
    }
  }
  return { valid: true, error: null };
}

function validateToolCallRequest(calls, tools, force) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { valid: false, error: 'The model did not return a tool call.' };
  }
  let validation = validateToolCalls(calls, tools);
  if (!validation.valid) return validation;
  validation = validateChoice(calls, force);
  if (!validation.valid) return validation;
  return { valid: true, error: null };
}

function detectToolLoop(messages, threshold = 3) {
  if (threshold < 1 || !Array.isArray(messages)) return false;
  const signatures = [];
  for (const message of messages) {
    if (!message) continue;
    for (const block of blocksOf(message.content)) {
      if (block && block.type === 'tool_use') {
        signatures.push(block.name + '|' + JSON.stringify(block.input || {}));
      }
    }
  }
  const tail = signatures.slice(-threshold);
  return tail.length >= threshold && tail.every((signature) => signature === tail[0]);
}

function usageCount(usage, keys) {
  if (!usage || typeof usage !== 'object') return null;
  for (const key of keys) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) return usage[key];
  }
  return null;
}

function normalizeUsage(providerUsage, inputEstimate, outputEstimate) {
  const prompt = usageCount(providerUsage, ['prompt_tokens', 'input_tokens']);
  const output = usageCount(providerUsage, ['completion_tokens', 'output_tokens']);
  const promptDetails = providerUsage && (
    providerUsage.prompt_tokens_details || providerUsage.input_tokens_details ||
    providerUsage.prompt_token_details || providerUsage.input_token_details
  );
  const cacheRead = usageCount(providerUsage, ['cache_read_input_tokens']) ??
    usageCount(promptDetails, ['cached_tokens', 'cache_read_tokens', 'cache_read_input_tokens']);
  const cacheCreation = usageCount(providerUsage, ['cache_creation_input_tokens']) ??
    usageCount(promptDetails, ['cache_write_tokens', 'cache_creation_tokens', 'cache_creation_input_tokens']);

  const input = prompt !== null
    ? Math.max(0, prompt - (cacheRead || 0) - (cacheCreation || 0))
    : inputEstimate;
  const result = {
    input_tokens: input,
    output_tokens: output !== null ? output : outputEstimate
  };
  if (cacheCreation !== null) result.cache_creation_input_tokens = cacheCreation;
  if (cacheRead !== null) result.cache_read_input_tokens = cacheRead;
  return result;
}

function hasProviderTokenTotals(providerUsage) {
  return usageCount(providerUsage, ['prompt_tokens', 'input_tokens']) !== null &&
    usageCount(providerUsage, ['completion_tokens', 'output_tokens']) !== null;
}

function resolveCompactionBudgets(capabilities, requestedOutputTokens) {
  const outputLimits = [COMPACTION_MAX_OUTPUT_TOKENS, requestedOutputTokens];
  const inputLimits = [COMPACTION_MAX_INPUT_TOKENS];

  if (capabilities && Number.isSafeInteger(capabilities.max_output_tokens) && capabilities.max_output_tokens > 0) {
    outputLimits.push(capabilities.max_output_tokens);
  }
  if (capabilities && Number.isSafeInteger(capabilities.max_input_tokens) && capabilities.max_input_tokens > 0) {
    inputLimits.push(capabilities.max_input_tokens);
  }

  let maxOutputTokens = Math.min(...outputLimits);
  if (capabilities && Number.isSafeInteger(capabilities.context_window_tokens) && capabilities.context_window_tokens > 0) {
    // Reserve the same safety margin used by the normal provider budget check.
    // Summary output is capped to 25% of the remaining context, leaving the
    // majority available for the transcript across small and large models.
    const availableContext = capabilities.context_window_tokens - CONTEXT_WINDOW_SAFETY_TOKENS;
    const contextOutputLimit = Math.max(1, Math.floor(availableContext * 0.25));
    maxOutputTokens = Math.min(maxOutputTokens, contextOutputLimit);
    inputLimits.push(Math.max(0,
      capabilities.context_window_tokens - maxOutputTokens - CONTEXT_WINDOW_SAFETY_TOKENS
    ));
  }

  const maxInputTokens = Math.min(...inputLimits);
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw Object.assign(new Error(
      'The provider context limits do not leave enough room for an autocompaction request.'
    ), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'PROVIDER_COMPACTION_BUDGET_UNAVAILABLE'
    });
  }

  return { maxInputTokens, maxOutputTokens };
}

function enforceProviderBudget(capabilities, estimatedInputTokens, requestedOutputTokens) {
  if (!capabilities) return;

  const maxOutput = capabilities.max_output_tokens;
  if (Number.isSafeInteger(maxOutput) && maxOutput > 0 && requestedOutputTokens > maxOutput) {
    throw Object.assign(new Error(
      'Requested max_tokens=' + requestedOutputTokens +
      ' exceeds the provider model output limit of ' + maxOutput + ' tokens.'
    ), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'PROVIDER_MAX_OUTPUT_EXCEEDED'
    });
  }

  const inputLimits = [];
  if (Number.isSafeInteger(capabilities.max_input_tokens) && capabilities.max_input_tokens > 0) {
    inputLimits.push(capabilities.max_input_tokens);
  }
  if (Number.isSafeInteger(capabilities.context_window_tokens) && capabilities.context_window_tokens > 0) {
    inputLimits.push(Math.max(0,
      capabilities.context_window_tokens - requestedOutputTokens - CONTEXT_WINDOW_SAFETY_TOKENS
    ));
  }

  if (!inputLimits.length) return;
  const maxAllowedInput = Math.min(...inputLimits);
  if (estimatedInputTokens > maxAllowedInput) {
    const contextDescription = Number.isSafeInteger(capabilities.context_window_tokens)
      ? ' within the ' + capabilities.context_window_tokens + '-token context window'
      : '';
    throw Object.assign(new Error(
      'Estimated provider input is ' + estimatedInputTokens +
      ' tokens, above the allowed ' + maxAllowedInput + ' tokens' + contextDescription +
      ' after reserving max_tokens=' + requestedOutputTokens +
      ' and a ' + CONTEXT_WINDOW_SAFETY_TOKENS + '-token safety margin. Reduce conversation history, tools, or max_tokens.'
    ), {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED'
    });
  }
}

async function requestCompletion(messages, body, signal, provider = {}, capabilities = null, diagnostic = {}) {
  const startedAt = Date.now();
  const requestId = diagnostic.requestId || null;
  const attempt = Number.isInteger(diagnostic.attempt) ? diagnostic.attempt : null;
  const phase = diagnostic.phase || 'initial';
  let estimatedInputTokens = null;
  let upstreamStarted = false;
  const record = (event, fields = {}) => {
    if (typeof diagnostic.logEvent !== 'function') return;
    try {
      diagnostic.logEvent(event, {
        request_id: requestId,
        provider_attempt: attempt,
        phase,
        recovery_attempt: Number.isInteger(diagnostic.recoveryAttempt) ? diagnostic.recoveryAttempt : null,
        ...fields
      });
    } catch {
      // Diagnostics are best-effort and must not affect provider calls.
    }
  };

  const nativeToolCalling = diagnostic.nativeToolCalling === true;
  const gatewayToolChoiceNone = body.tool_choice === 'none';
  const profileGeneration = modelProfileGeneration(body.model) || {};
  const profileProviderParams = profileGeneration.provider_params || {};
  const requestProviderParams = body.provider_params || {};
  const options = {
    max_tokens: body.max_tokens,
    temperature: body.temperature !== undefined ? body.temperature : profileGeneration.temperature,
    top_p: body.top_p !== undefined ? body.top_p : profileGeneration.top_p,
    top_k: body.top_k !== undefined ? body.top_k : profileGeneration.top_k,
    provider_params: { ...profileProviderParams, ...requestProviderParams },
    stop_sequences: body.stop_sequences,
    reasoning_effort: body.output_config && body.output_config.effort !== undefined && body.output_config.effort !== null
      ? body.output_config.effort
      : profileGeneration.reasoning_effort,
    nativeToolCalling,
    // Native tool schemas never cross the provider boundary in DSML text mode.
    tools: nativeToolCalling && !gatewayToolChoiceNone ? body.tools : [],
    tool_choice: nativeToolCalling && !gatewayToolChoiceNone ? body.tool_choice : 'none',
    providerToolNameMap: diagnostic.providerToolNameMap || null,
    anthropicVersion: diagnostic.anthropicVersion
  };

  try {
    const hasInjectedProvider = Boolean(
      provider && (
        typeof provider.createChatCompletion === 'function' ||
        typeof provider.createStreamingChatCompletion === 'function' ||
        typeof provider.streamChatCompletionEvents === 'function'
      )
    );
    const samplingCapabilities = provider && typeof provider.getSamplingCapabilities === 'function'
      ? await provider.getSamplingCapabilities()
      : hasInjectedProvider ? null : await getSamplingCapabilities();
    if (samplingCapabilities) {
      const filtered = filterSamplingOptions(options, samplingCapabilities);
      // Replace, rather than merge, because omitted keys must be physically
      // removed from the original options object before building the provider payload.
      for (const key of Object.keys(options)) delete options[key];
      Object.assign(options, filtered.options);
      if (filtered.omitted.length) {
        record('provider.sampling.parameters_omitted', {
          omitted_parameters: filtered.omitted,
          discovery_source: samplingCapabilities.source || 'unknown',
          discovery_status: samplingCapabilities.status || 'unknown'
        });
      }
    }
    estimatedInputTokens = estimateProviderInputTokens(messages);
    enforceProviderBudget(capabilities, estimatedInputTokens, body.max_tokens);

    record('provider.request.started', {
      provider_model: PROVIDER_MODEL || null,
      stream: body.stream === true,
      max_tokens: body.max_tokens,
      message_count: messages.length,
      tool_count: Array.isArray(options.tools) ? options.tools.length : 0,
      tool_names: Array.isArray(options.tools) ? options.tools.map((tool) => tool && tool.name).filter(Boolean) : [],
      estimated_input_tokens: estimatedInputTokens,
      request_intent: diagnostic.requestIntent || 'normal',
      compaction_max_input_tokens: diagnostic.compactionMaxInputTokens || null,
      compaction_max_output_tokens: diagnostic.compactionMaxOutputTokens || null,
      content: { messages, options }
    });
    upstreamStarted = true;

    const streamCall = provider.createStreamingChatCompletion || createStreamingChatCompletion;
    const streamEventsCall = provider.streamChatCompletionEvents ||
      (typeof provider.createStreamingChatCompletion === 'function' ? null : streamChatCompletionEvents);
    const normalCall = provider.createChatCompletion || createChatCompletion;
    let result;
    if (body.stream === true && typeof diagnostic.onStreamEvent === 'function' && streamEventsCall) {
      let streamedChars = 0;
      for await (const event of streamEventsCall(messages, options, signal)) {
        if (event.type === 'completion') {
          result = event.completion;
          continue;
        }
        if (event.type === 'text_delta' && typeof event.text === 'string') {
          streamedChars += event.text.length;
        } else if (event.type === 'tool_call_delta') {
          streamedChars += JSON.stringify(event.deltas || []).length;
        }
        if (streamedChars > MAX_OUTPUT_CHARS) {
          throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
            statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
          });
        }
        await diagnostic.onStreamEvent(event);
      }
    } else {
      result = body.stream === true
        ? await streamCall(messages, options, signal)
        : await normalCall(messages, options, signal);
    }
    if (!result || typeof result.text !== 'string') {
      throw Object.assign(new Error('Provider completion did not contain text output.'), {
        statusCode: 502, type: 'api_error', code: 'PROVIDER_INVALID_RESPONSE'
      });
    }
    const nativeToolOutputChars = Array.isArray(result.tool_calls)
      ? JSON.stringify(result.tool_calls).length
      : 0;
    if (result.text.length + nativeToolOutputChars > MAX_OUTPUT_CHARS) {
      throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
        statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
      });
    }

    record('provider.response.completed', {
      provider_model: result.provider_model || PROVIDER_MODEL || null,
      duration_ms: Date.now() - startedAt,
      response_chars: result.text.length,
      tool_call_count: Array.isArray(result.tool_calls) ? result.tool_calls.length : 0,
      finish_reason: result.finish_reason || null,
      usage: result.usage || null,
      content: {
        text: result.text,
        tool_calls: Array.isArray(result.tool_calls) ? result.tool_calls : [],
        reasoning: result.reasoning || '',
        finish_reason: result.finish_reason || null
      }
    });
    return { ...result, input_tokens_estimated: estimatedInputTokens };
  } catch (error) {
    record(upstreamStarted ? 'provider.request.failed' : 'provider.request.rejected', {
      level: upstreamStarted ? 'error' : 'warn',
      provider_model: PROVIDER_MODEL || null,
      upstream_started: upstreamStarted,
      estimated_input_tokens: estimatedInputTokens,
      error_code: error.code || 'PROVIDER_ERROR',
      status: error.statusCode || 502,
      message: String(error.message || error).slice(0, 1000),
      duration_ms: Date.now() - startedAt
    });
    throw error;
  }
}

function parseCompletionToolCalls(completion, nativeToolCalling = true, providerToolNameMap = null) {
  if (nativeToolCalling) {
    const native = normalizeProviderToolCalls(completion.tool_calls, () => uuid('call'));
    native.calls = restoreProviderToolCallNames(native.calls, providerToolNameMap);
    const parsed = {
      text: typeof completion.text === 'string' ? completion.text : '',
      calls: native.calls,
      errors: [],
      hasProtocol: false,
      protocolSource: native.calls.length > 0 ? 'provider_native' : 'unknown'
    };
    if (native.error) return { parsed, calls: [], error: native.error, native: true };
    return {
      parsed,
      calls: native.calls,
      error: null,
      native: native.calls.length > 0
    };
  }

  const adapted = convertDsmlToBYV(completion.text);
  const parsed = parseBYVOutput(adapted.text);
  parsed.protocolSource = adapted.detected
    ? 'dsml_converted_to_byv'
    : parsed.hasProtocol ? 'byv_format_block' : 'unknown';
  const hasNativeToolCalls = Array.isArray(completion.tool_calls) && completion.tool_calls.length > 0;

  if (hasNativeToolCalls) {
    const rejectedNative = normalizeProviderToolCalls(completion.tool_calls, () => uuid('rejected_native'));
    const rejectedToolCalls = rejectedNative.calls.length > 0
      ? rejectedNative.calls.map((call) => ({ name: call.name, input: call.input }))
      : completion.tool_calls.slice(0, 8).map((item) => ({
          name: item && item.function && typeof item.function.name === 'string' ? item.function.name : '[UNKNOWN]',
          input: null
        }));

    return {
      parsed,
      calls: [],
      error: parsed.hasProtocol
        ? (parsed.calls.length > 0
          ? 'Provider returned both native function calls and textual tool-call markup while native function calling is disabled.'
          : (parsed.errors[0] || 'Provider returned native function calls together with textual tool-call markup.'))
        : 'Native provider function calls are disabled; use DSML text tool calls instead.',
      native: true,
      rejectedToolCalls,
      rejectionReason: 'PROVIDER_NATIVE_DISABLED',
      nativeParseError: rejectedNative.error || null
    };
  }

  return {
    parsed,
    calls: parsed.calls,
    error: parsed.errors[0] || null,
    native: false
  };
}


function validateTextOnlyCompletion(completion, nativeToolCalling = false, providerToolNameMap = null) {
  // Native-mode validation inspects only structured provider calls; DSML parsing
  // is reserved for DSML text mode.
  const result = parseCompletionToolCalls(completion, nativeToolCalling, providerToolNameMap);
  const base = {
    parsed: result.parsed,
    calls: result.calls,
    native: result.native,
    parseError: result.error || null
  };

  if (result.error) {
    return { ...base, valid: false, error: result.error };
  }
  if (completion.finish_reason === 'tool_calls') {
    return {
      ...base,
      valid: false,
      error: 'The provider returned a tool-call finish reason while tool use was disabled.'
    };
  }
  if (TEXT_ONLY_TOOL_CALL_MARKER.test(maskMarkdownCode(result.parsed.text))) {
    return {
      ...base,
      valid: false,
      error: 'The model emitted a legacy or JSON tool-call wrapper while tool use was disabled.'
    };
  }
  if (result.calls.length > 0) {
    return {
      ...base,
      valid: false,
      error: 'The model attempted a tool call while tool use was disabled.'
    };
  }
  if (result.parsed.hasProtocol || result.parsed.errors.length > 0) {
    return {
      ...base,
      valid: false,
      error: result.parsed.errors[0] || 'The model emitted tool-call markup while tool use was disabled.'
    };
  }
  if (typeof result.parsed.text !== 'string' || !result.parsed.text.trim()) {
    return {
      ...base,
      valid: false,
      error: 'The text-only recovery returned an empty response.'
    };
  }

  return { ...base, valid: true, error: null };
}

function classifyToolCallValidationError(error) {
  const message = String(error || '');
  if (/was not declared in this request/i.test(message)) return 'TOOL_NOT_DECLARED';
  if (/failed schema validation/i.test(message)) return 'TOOL_SCHEMA_INVALID';
  if (/duplicate invocation id/i.test(message)) return 'DUPLICATE_INVOCATION_ID';
  if (/batch exceeds the maximum/i.test(message)) return 'TOOL_BATCH_LIMIT_EXCEEDED';
  if (/tool_choice requires/i.test(message)) return 'TOOL_CHOICE_MISMATCH';
  if (/must be a JSON object/i.test(message)) return 'INVALID_ARGUMENT_OBJECT';
  if (/missing a valid id/i.test(message)) return 'INVALID_INVOCATION_ID';
  if (/missing a valid tool name/i.test(message)) return 'INVALID_TOOL_NAME';
  if (/no BYV invocation/i.test(message)) return 'EMPTY_TOOL_BATCH';
  return 'TOOL_VALIDATION_FAILED';
}

function boundedLogString(value, maxLength) {
  return typeof value === 'string' && value.length
    ? value.slice(0, maxLength)
    : null;
}

// Log metadata only. Never include call.input, provider arguments, prompts, or tool results.
function logToolCallValidation(options = {}) {
  const logger = options.logger;
  if (typeof logger !== 'function') return;

  const calls = Array.isArray(options.calls) ? options.calls : [];
  const parseError = options.parseError || null;
  const parsed = options.parsed || null;
  const source = options.native
    ? 'provider_native'
    : parsed && parsed.protocolSource
      ? parsed.protocolSource
      : parsed && parsed.hasProtocol
        ? 'byv_format_block'
        : 'unknown';
  const validation = validateToolCallRequest(
    calls,
    Array.isArray(options.tools) ? options.tools : [],
    options.force || { mode: 'auto' }
  );
  const disabled = options.toolsDisabled === true;
  const rejected = disabled || Boolean(parseError) || !validation.valid;
  const reason = disabled
    ? 'TOOL_USE_DISABLED'
    : parseError
      ? (String(parseError).includes('both native function calls and textual tool-call markup')
        ? 'AMBIGUOUS_TOOL_OUTPUT'
        : String(parseError).includes('Native provider function calls are disabled')
          ? 'PROVIDER_NATIVE_DISABLED'
          : source === 'provider_native' ? 'PROVIDER_NATIVE_PARSE_ERROR' : 'BYV_PARSE_ERROR')
      : !validation.valid
        ? classifyToolCallValidationError(validation.error)
        : null;
  const base = {
    request_id: boundedLogString(options.requestId, 128),
    source,
    phase: options.phase || 'initial',
    recovery_attempt: Number.isInteger(options.attempt) ? options.attempt : null
  };

  const emit = (entry) => {
    try {
      logger({
        level: rejected ? 'warn' : 'info',
        ...entry
      });
    } catch (error) {
      // Diagnostics must never change tool execution or recovery behavior.
    }
  };

  if (calls.length === 0) {
    if (parseError || (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0)) {
      emit({
        event: 'tool_call.parse_rejected',
        ...base,
        invocation_id: null,
        tool_name: null,
        validation_status: 'rejected',
        validation_reason: reason || 'TOOL_PARSE_ERROR'
      });
    }
    return;
  }

  for (const call of calls) {
    emit({
      event: rejected ? 'tool_call.rejected' : 'tool_call.validated',
      ...base,
      invocation_id: boundedLogString(call && call.id, 128),
      tool_name: boundedLogString(call && call.name, 128),
      validation_status: rejected ? 'rejected' : 'valid',
      validation_reason: reason
    });
  }
}

async function handleMessages(body, options = {}) {
  const signal = options.signal;
  const noToolExperiment = typeof options.noToolExperiment === 'boolean'
    ? options.noToolExperiment
    : DSML_TOOL_CALL;
  // DSML mode is text-only at the provider boundary. Native mode uses the
  // provider's structured tool_calls and never parses DSML/legacy tool markup.
  let nativeToolCalling = noToolExperiment
    ? false
    : (typeof options.nativeToolCalling === 'boolean' ? options.nativeToolCalling : true);
  const model = body.model;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const experimentVariant = options.experimentVariant === 'B' ? 'B' : 'A';
  const repeatedToolLoop = detectToolLoop(body.messages, 3);
  const compactionRequest = isClaudeCodeCompactionRequest(body);
  // Compaction is a text-only summary turn even when Claude Code repeats its
  // normal tool catalog. Never interpret summary examples as executable calls.
  const force = compactionRequest || repeatedToolLoop || tools.length === 0
    ? { mode: 'none' }
    : parseToolChoice(body.tool_choice);
  let providerToolNameMap = nativeToolCalling && force.mode !== 'none'
    ? createProviderToolNameMap(tools)
    : null;
  const baseRequestBody = force.mode === 'none' ? { ...body, tool_choice: 'none' } : body;
  const provider = options.provider || {};
  const providerCapabilities = typeof provider.getModelCapabilities === 'function'
    ? await provider.getModelCapabilities()
    : await getModelCapabilities();
  const compactionBudgets = compactionRequest
    ? resolveCompactionBudgets(providerCapabilities, body.max_tokens)
    : null;
  const requestBody = compactionBudgets
    ? { ...baseRequestBody, max_tokens: compactionBudgets.maxOutputTokens }
    : baseRequestBody;
  let providerMessages = compactionRequest
    ? buildCompactionProviderMessages(requestBody, {
        maxInputTokens: compactionBudgets.maxInputTokens
      })
    : buildProviderMessages(requestBody, {
        nativeToolCalling,
        noToolExperiment,
        experimentVariant
      });
  let providerAttempt = 0;
  // The server has already committed the Anthropic SSE lifecycle (message_start).
  // A retry would therefore replay a request inside an already-open client stream.
  let streamOutputStarted = body.stream === true && typeof options.onStreamEvent === 'function';
  let streamContentSent = false;
  let nativeToolFallbackAttempted = false;
  const complete = async (messages, phase = 'initial', recoveryAttempt = null) => {
    let retry = 0;
    let requestMessages = messages;
    while (true) {
      try {
        return await requestCompletion(requestMessages, requestBody, signal, provider, providerCapabilities, {
          logEvent: options.diagnostics,
          requestId: options.requestId,
          attempt: ++providerAttempt,
          phase,
          recoveryAttempt,
          nativeToolCalling,
          providerToolNameMap,
          requestIntent: options.requestIntent || (compactionRequest ? 'claude_code_compaction' : 'normal'),
          compactionMaxInputTokens: compactionBudgets ? compactionBudgets.maxInputTokens : null,
          compactionMaxOutputTokens: compactionBudgets ? compactionBudgets.maxOutputTokens : null,
          anthropicVersion: options.anthropicVersion,
          onStreamEvent: phase === 'initial' &&
            typeof options.onStreamEvent === 'function' &&
            force.mode !== 'any' && force.mode !== 'tool' && force.mode !== 'required'
            ? async (event) => {
                if (event.type === 'text_delta') {
                  streamOutputStarted = true;
                  streamContentSent = true;
                }
                await options.onStreamEvent(event);
              }
            : null
        });
      } catch (error) {
        const code = String(error && error.code || '');
        const canFallbackToDsml = PROVIDER_NATIVE_TOOL_FALLBACK_TO_DSML &&
          !nativeToolFallbackAttempted &&
          phase === 'initial' &&
          nativeToolCalling &&
          tools.length > 0 &&
          force.mode !== 'none' &&
          code === 'UPSTREAM_HTTP_400' &&
          !signal?.aborted &&
          !streamContentSent;
        if (canFallbackToDsml) {
          nativeToolFallbackAttempted = true;
          nativeToolCalling = false;
          providerToolNameMap = null;
          providerMessages = buildProviderMessages(requestBody, {
            nativeToolCalling: false,
            noToolExperiment,
            experimentVariant
          });
          requestMessages = providerMessages;
          retry = 0;
          if (typeof options.diagnostics === 'function') {
            try {
              options.diagnostics('provider.native_tools.fallback_to_dsml', {
                level: 'warn',
                request_id: options.requestId || null,
                phase,
                previous_error_code: code,
                fallback_transport: 'dsml'
              });
            } catch {}
          }
          continue;
        }
        const retryable = !signal?.aborted && !streamOutputStarted &&
          code !== 'CLIENT_DISCONNECTED' &&
          code !== 'PROVIDER_CONTEXT_WINDOW_EXCEEDED' &&
          code !== 'PROVIDER_MAX_OUTPUT_EXCEEDED' &&
          (['PROVIDER_TIMEOUT', 'PROVIDER_CONNECTION_FAILED', 'PROVIDER_STREAM_INCOMPLETE'].includes(code) ||
            /^UPSTREAM_HTTP_(500|502|503|504|529)$/.test(code));
        if (!retryable || retry >= MAX_PROVIDER_RETRIES) throw error;
        retry++;
        if (typeof options.diagnostics === 'function') {
          try {
            options.diagnostics('provider.request.retry_scheduled', {
              level: 'warn', request_id: options.requestId || null, phase,
              recovery_attempt: recoveryAttempt, retry_number: retry,
              previous_error_code: code, delay_ms: 250 * retry
            });
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * retry));
        if (signal?.aborted) {
          throw Object.assign(new Error('Provider retry cancelled because the client disconnected.'), {
            statusCode: 499, type: 'api_error', code: 'CLIENT_DISCONNECTED'
          });
        }
      }
    }
  };
  let completion = await complete(providerMessages);

  if (completion.text.length > MAX_OUTPUT_CHARS) {
    throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
      statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
    });
  }

  let parsedResult = parseCompletionToolCalls(completion, nativeToolCalling, providerToolNameMap);
  let parsed = parsedResult.parsed;
  let calls = parsedResult.calls;
  let parseError = parsedResult.error;
  let validation = validateToolCallRequest(calls, tools, force);
  if (!validation.valid && parseError) {
    validation.error = parseError + ' ' + validation.error;
  }

  const toolsDisabled = force.mode === 'none' || tools.length === 0;
  const unexpectedCalls = calls.length > 0 && toolsDisabled;
  const malformedProtocol = Boolean(parseError) ||
    (toolsDisabled && (TEXT_ONLY_TOOL_CALL_MARKER.test(maskMarkdownCode(parsed.text)) || completion.finish_reason === 'tool_calls')) ||
    (parsed.hasProtocol && (parsed.errors.length > 0 || (calls.length === 0 && parsed.text === '')));
  const emptyTextResponse = calls.length === 0 &&
    !parsed.hasProtocol &&
    !parsed.text.trim();

  logToolCallValidation({
    logger: options.logger,
    requestId: options.requestId,
    calls,
    tools,
    force,
    parsed,
    native: parsedResult.native,
    parseError,
    toolsDisabled,
    phase: 'initial'
  });

  if (toolsDisabled && (unexpectedCalls || malformedProtocol || emptyTextResponse)) {
    let recovered = false;
    let lastError = unexpectedCalls
      ? 'The model attempted to call a tool while tool use was disabled.'
      : malformedProtocol
        ? (parseError || parsed.errors[0] || 'The model emitted tool-call syntax while tool use was disabled.')
        : 'The model returned an empty response while tool use was disabled.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'text', {
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          nativeToolCalling,
          noToolExperiment: !nativeToolCalling
        })
      }]);
      completion = await complete(retryMessages, 'text_recovery', attempt);
      const textRecovery = validateTextOnlyCompletion(completion, nativeToolCalling, providerToolNameMap);
      logToolCallValidation({
        logger: options.logger,
        requestId: options.requestId,
        calls: textRecovery.calls,
        tools,
        force: { mode: 'none' },
        parsed: textRecovery.parsed,
        native: textRecovery.native,
        parseError: textRecovery.parseError,
        toolsDisabled: true,
        phase: 'text_recovery',
        attempt
      });
      parsed = textRecovery.parsed;
      if (textRecovery.valid) {
        calls = [];
        parseError = null;
        recovered = true;
        break;
      }
      lastError = textRecovery.error;
    }
    if (!recovered) {
      throw Object.assign(new Error('Model could not produce a non-empty plain-text response while tool use was disabled. No tool call was forwarded.'), {
        statusCode: 502, type: 'api_error', code: 'BYV_TEXT_RECOVERY_FAILED'
      });
    }
  } else if (tools.length > 0 && (
    parseError ||
    parsed.errors.length > 0 ||
    (calls.length > 0 && !validation.valid)
  )) {
    let recovered = false;
    let lastError = validation.error || parseError || 'Malformed BYV output.';
    let recoveryFailureKind = parsedResult.native && !nativeToolCalling ? 'provider_native_disabled' : 'invalid_tool_call';
    let rejectedToolCalls = parsedResult.rejectedToolCalls || [];
    let rejectionReason = parsedResult.rejectionReason || null;
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'tool', {
          nativeToolCalling,
          noToolExperiment: !nativeToolCalling,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          failureKind: recoveryFailureKind,
          rejectionReason,
          rejectedToolCalls
        })
      }]);
      completion = await complete(retryMessages, 'tool_recovery', attempt);
      if (completion.text.length > MAX_OUTPUT_CHARS) {
        lastError = 'The recovery output exceeded the configured maximum size.';
        recoveryFailureKind = 'invalid_tool_call';
        rejectedToolCalls = [];
        rejectionReason = null;
        continue;
      }
      parsedResult = parseCompletionToolCalls(completion, nativeToolCalling, providerToolNameMap);
      parsed = parsedResult.parsed;
      calls = parsedResult.calls;
      validation = validateToolCallRequest(calls, tools, force);
      if (!validation.valid && parsedResult.error) validation.error = parsedResult.error + ' ' + validation.error;
      logToolCallValidation({
        logger: options.logger,
        requestId: options.requestId,
        calls,
        tools,
        force,
        parsed,
        native: parsedResult.native,
        parseError: parsedResult.error,
        phase: 'tool_recovery',
        attempt
      });
      if (!parsedResult.error && validation.valid && calls.length > 0) {
        recovered = true;
        break;
      }
      lastError = validation.error || parsedResult.error || 'The recovery did not return a valid tool call.';
      recoveryFailureKind = parsedResult.native && !nativeToolCalling ? 'provider_native_disabled' : 'invalid_tool_call';
      rejectedToolCalls = parsedResult.rejectedToolCalls || [];
      rejectionReason = parsedResult.rejectionReason || null;
    }
    if (!recovered) {
      throw Object.assign(new Error(
        'BYV tool-call recovery failed after ' + MAX_RECOVERY_ATTEMPTS +
        ' attempt(s). Last validation issue: ' + lastError
      ), {
        statusCode: 502,
        type: 'api_error',
        code: 'BYV_TOOL_CALL_RECOVERY_FAILED'
      });
    }
  } else if (force.mode === 'any' || force.mode === 'tool') {
    if (!calls.length) {
      let recovered = false;
      let lastError = 'tool_choice requires a tool call, but the model returned text.';
      let recoveryFailureKind = parsedResult.native && !nativeToolCalling ? 'provider_native_disabled' : 'tool_call_missing';
      let rejectedToolCalls = parsedResult.rejectedToolCalls || [];
      let rejectionReason = parsedResult.rejectionReason || null;
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        const retryMessages = providerMessages.concat([{
          role: 'user',
          content: buildRecoveryMessage(lastError, attempt, 'tool', {
            nativeToolCalling,
            noToolExperiment: !nativeToolCalling,
            maxAttempts: MAX_RECOVERY_ATTEMPTS,
            failureKind: recoveryFailureKind,
            rejectionReason,
            rejectedToolCalls
          })
        }]);
        completion = await complete(retryMessages, 'required_tool_recovery', attempt);
        parsedResult = parseCompletionToolCalls(completion, nativeToolCalling, providerToolNameMap);
        parsed = parsedResult.parsed;
        calls = parsedResult.calls;
        validation = validateToolCallRequest(calls, tools, force);
        if (!validation.valid && parsedResult.error) {
          validation.error = parsedResult.error + ' ' + validation.error;
        }
        logToolCallValidation({
          logger: options.logger,
          requestId: options.requestId,
          calls,
          tools,
          force,
          parsed,
          native: parsedResult.native,
          parseError: parsedResult.error,
          phase: 'required_tool_recovery',
          attempt
        });
        if (!parsedResult.error && validation.valid && calls.length) {
          recovered = true;
          break;
        }
        lastError = validation.error || parsedResult.error || 'No valid tool call returned.';
        recoveryFailureKind = parsedResult.native && !nativeToolCalling ? 'provider_native_disabled' : 'invalid_tool_call';
        rejectedToolCalls = parsedResult.rejectedToolCalls || [];
        rejectionReason = parsedResult.rejectionReason || null;
      }
      if (!recovered) {
        throw Object.assign(new Error('The model did not produce the tool call required by tool_choice.'), {
          statusCode: 502, type: 'api_error', code: 'BYV_REQUIRED_TOOL_MISSING'
        });
      }
    }
  }

  if (calls.length > 0) {
    const finalValidation = validateToolCallRequest(calls, tools, force);
    if (!finalValidation.valid) {
      throw Object.assign(new Error('Tool calls were rejected: ' + finalValidation.error), {
        statusCode: 502, type: 'api_error', code: 'BYV_TOOL_VALIDATION_FAILED'
      });
    }
  }

  const result = {
    id: completion.id || uuid('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: calls.length ? 'tool_use' :
      (['length', 'max_tokens'].includes(completion.finish_reason) ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    text: parsed.text,
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    reasoning: completion.reasoning || ''
  };
  if (result.text) result.content.push({ type: 'text', text: result.text });
  for (const call of result.toolCalls) {
    result.content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input
    });
  }
  if (!result.content.length) result.content.push({ type: 'text', text: '' });

  const outputEstimate = estimateOutputTokens(result);
  result.usage = normalizeUsage(completion.usage, completion.input_tokens_estimated, outputEstimate);
  result.usage_estimated = !hasProviderTokenTotals(completion.usage);
  return result;
}

module.exports = {
  handleMessages,
  parseToolChoice,
  validateChoice,
  detectToolLoop,
  normalizeUsage,
  hasProviderTokenTotals,
  enforceProviderBudget,
  resolveCompactionBudgets,
  parseCompletionToolCalls
};
