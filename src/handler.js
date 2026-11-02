'use strict';

const { MAX_RECOVERY_ATTEMPTS, MAX_OUTPUT_CHARS, CONTEXT_WINDOW_SAFETY_TOKENS, PROVIDER_NATIVE_TOOL_CALLING, uuid } = require('./config');
const { buildProviderMessages, buildRecoveryMessage } = require('./prompts');
const { createChatCompletion, createStreamingChatCompletion } = require('./provider/openai-compatible');
const { parseBYVOutput } = require('./protocol/parser');
const { validateToolCalls } = require('./tools/validator');
const { blocksOf, estimateProviderInputTokens, estimateOutputTokens } = require('./content');
const { getModelCapabilities } = require('./provider/capabilities');
const { normalizeProviderToolCalls } = require('./provider/tool-calls');

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

async function requestCompletion(messages, body, signal, provider = {}, capabilities = null) {
  const estimatedInputTokens = estimateProviderInputTokens(messages);
  enforceProviderBudget(capabilities, estimatedInputTokens, body.max_tokens);
  const options = {
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop_sequences,
    reasoning_effort: body.output_config && body.output_config.effort,
    tools: body.tools,
    tool_choice: body.tool_choice
  };
  const streamCall = provider.createStreamingChatCompletion || createStreamingChatCompletion;
  const normalCall = provider.createChatCompletion || createChatCompletion;
  const result = body.stream === true
    ? await streamCall(messages, options, signal)
    : await normalCall(messages, options, signal);
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
  return { ...result, input_tokens_estimated: estimatedInputTokens };
}

function parseCompletionToolCalls(completion, nativeToolCalling = PROVIDER_NATIVE_TOOL_CALLING) {
  const parsed = parseBYVOutput(completion.text);
  const hasNativeToolCalls = Array.isArray(completion.tool_calls) && completion.tool_calls.length > 0;

  if (!nativeToolCalling && hasNativeToolCalls) {
    if (parsed.hasProtocol) {
      return {
        parsed,
        calls: [],
        error: parsed.calls.length > 0
          ? 'Provider returned both native function calls and BYV markup while native function calling is disabled.'
          : (parsed.errors[0] || 'Provider returned native function calls together with BYV protocol markup.'),
        native: true
      };
    }
    return {
      parsed,
      calls: [],
      error: 'Native provider function calls are disabled; use BYV Format Block instead.',
      native: true
    };
  }

  const native = normalizeProviderToolCalls(completion.tool_calls, () => uuid('call'));
  if (native.error) {
    return { parsed, calls: [], error: native.error, native: true };
  }
  if (native.calls.length > 0 && parsed.calls.length > 0) {
    return {
      parsed,
      calls: [],
      error: 'Provider returned both native function calls and BYV markup in the same response.',
      native: true
    };
  }
  if (native.calls.length > 0 && parsed.hasProtocol) {
    return {
      parsed,
      calls: [],
      error: parsed.errors[0] || 'Provider returned native function calls together with BYV protocol markup.',
      native: true
    };
  }
  return {
    parsed,
    calls: native.calls.length > 0 ? native.calls : parsed.calls,
    error: parsed.errors[0] || null,
    native: native.calls.length > 0
  };
}

function validateTextOnlyCompletion(completion) {
  const result = parseCompletionToolCalls(completion, false);
  const base = {
    parsed: result.parsed,
    calls: result.calls,
    native: result.native,
    parseError: result.error || null
  };

  if (result.error) {
    return { ...base, valid: false, error: result.error };
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
      error: result.parsed.errors[0] || 'The model emitted BYV protocol markup while tool use was disabled.'
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
      ? (String(parseError).includes('both native function calls and BYV markup')
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
  const nativeToolCalling = typeof options.nativeToolCalling === 'boolean'
    ? options.nativeToolCalling
    : PROVIDER_NATIVE_TOOL_CALLING;
  const model = body.model;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const repeatedToolLoop = detectToolLoop(body.messages, 3);
  const force = repeatedToolLoop ? { mode: 'none' } : parseToolChoice(body.tool_choice);
  // Enforce loop prevention at both layers: the system prompt and provider API.
  // Reuse this effective body for every retry so recovery cannot re-enable tools.
  const requestBody = repeatedToolLoop ? { ...body, tool_choice: 'none' } : body;
  const providerMessages = buildProviderMessages(requestBody);
  const provider = options.provider || {};
  const providerCapabilities = typeof provider.getModelCapabilities === 'function'
    ? await provider.getModelCapabilities()
    : await getModelCapabilities();
  let completion = await requestCompletion(providerMessages, requestBody, signal, provider, providerCapabilities);

  if (completion.text.length > MAX_OUTPUT_CHARS) {
    throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
      statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
    });
  }

  let parsedResult = parseCompletionToolCalls(completion, nativeToolCalling);
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
        ? (parseError || parsed.errors[0] || 'Malformed BYV output while tool use was disabled.')
        : 'The model returned an empty response while tool use was disabled.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'text')
      }]);
      completion = await requestCompletion(retryMessages, requestBody, signal, provider, providerCapabilities);
      const textRecovery = validateTextOnlyCompletion(completion);
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
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'tool', { nativeToolCalling })
      }]);
      completion = await requestCompletion(retryMessages, requestBody, signal, provider, providerCapabilities);
      if (completion.text.length > MAX_OUTPUT_CHARS) {
        lastError = 'The recovery output exceeded the configured maximum size.';
        continue;
      }
      parsedResult = parseCompletionToolCalls(completion, nativeToolCalling);
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
        phase: 'tool_recovery',
        attempt
      });
      if (!parsedResult.error && validation.valid && calls.length > 0) {
        recovered = true;
        break;
      }
      lastError = validation.error || parsedResult.error || 'The recovery did not return a valid tool call.';
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
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
        const retryMessages = providerMessages.concat([{
          role: 'user',
          content: buildRecoveryMessage(lastError, attempt, 'tool', { nativeToolCalling })
        }]);
        completion = await requestCompletion(retryMessages, requestBody, signal, provider, providerCapabilities);
        parsedResult = parseCompletionToolCalls(completion, nativeToolCalling);
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
    id: uuid('msg'),
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
  parseCompletionToolCalls
};