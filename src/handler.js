'use strict';

const { MAX_RECOVERY_ATTEMPTS, MAX_OUTPUT_CHARS, CONTEXT_WINDOW_SAFETY_TOKENS, PROVIDER_NATIVE_TOOL_CALLING, uuid } = require('./config');
const { buildProviderMessages, buildRecoveryMessage } = require('./prompts');
const { createChatCompletion, createStreamingChatCompletion } = require('./provider/openai-compatible');
const { parseBYVOutput } = require('./protocol/parser');
const { validateToolCalls } = require('./tools/validator');
const { estimateProviderInputTokens, estimateOutputTokens } = require('./content');
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

function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }
  }
  return '';
}

function extractExactBashCommand(messages) {
  const text = latestUserText(messages);
  const patterns = [
    /(?:jalankan|eksekusi)\s+persis\s+perintah\s*:\s*`([^`\r\n]+)`/i,
    /(?:jalankan|eksekusi)\s+persis\s+perintah\s*:\s*([^\r\n]+)/i,
    /run\s+exactly\s+(?:the\s+)?command\s*:\s*`([^`\r\n]+)`/i,
    /run\s+exactly\s+(?:the\s+)?command\s*:\s*([^\r\n]+)/i,
    /execute\s+exactly\s+(?:the\s+)?command\s*:\s*`([^`\r\n]+)`/i,
    /execute\s+exactly\s+(?:the\s+)?command\s*:\s*([^\r\n]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const command = String(match[1] || match[2] || '').trim();
      if (command) return command;
    }
  }
  return null;
}

function validateExactBashCommand(calls, expectedCommand) {
  if (calls.length !== 1 || !calls[0] || calls[0].name !== 'Bash') {
    return {
      valid: false,
      error: 'The user explicitly requested one Bash call with the exact command ' +
        JSON.stringify(expectedCommand) + '. Return exactly one Bash invocation and no other tool calls.'
    };
  }
  const actualCommand = calls[0].input && calls[0].input.command;
  if (actualCommand !== expectedCommand) {
    return {
      valid: false,
      error: 'The Bash command does not match the exact command supplied by the user. Expected command: ' +
        JSON.stringify(expectedCommand) + '. Received command: ' + JSON.stringify(actualCommand) +
        '. Return the expected command unchanged. Do not append, prepend, chain, or substitute commands.'
    };
  }
  return { valid: true, error: null };
}

function validateToolCallRequest(calls, tools, force, exactBashCommand) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { valid: false, error: 'The model did not return a tool call.' };
  }
  let validation = validateToolCalls(calls, tools);
  if (!validation.valid) return validation;
  validation = validateChoice(calls, force);
  if (!validation.valid) return validation;
  if (exactBashCommand !== null) {
    validation = validateExactBashCommand(calls, exactBashCommand);
    if (!validation.valid) return validation;
  }
  return { valid: true, error: null };
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

function parseCompletionToolCalls(completion) {
  const native = normalizeProviderToolCalls(completion.tool_calls, () => uuid('call'));
  const parsed = parseBYVOutput(completion.text);

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

async function handleMessages(body, options = {}) {
  const signal = options.signal;
  const model = body.model;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const force = parseToolChoice(body.tool_choice);
  const exactBashCommand = tools.some((tool) => tool && tool.name === 'Bash')
    ? extractExactBashCommand(body.messages)
    : null;
  const providerMessages = buildProviderMessages(body);
  const provider = options.provider || {};
  const providerCapabilities = typeof provider.getModelCapabilities === 'function'
    ? await provider.getModelCapabilities()
    : await getModelCapabilities();
  let completion = await requestCompletion(providerMessages, body, signal, provider, providerCapabilities);

  if (completion.text.length > MAX_OUTPUT_CHARS) {
    throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
      statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
    });
  }

  let parsedResult = parseCompletionToolCalls(completion);
  let parsed = parsedResult.parsed;
  let calls = parsedResult.calls;
  let parseError = parsedResult.error;
  let validation = validateToolCallRequest(calls, tools, force, exactBashCommand);
  if (!validation.valid && parseError) {
    validation.error = parseError + ' ' + validation.error;
  }

  const toolsDisabled = force.mode === 'none' || tools.length === 0;
  const unexpectedCalls = calls.length > 0 && toolsDisabled;
  const malformedProtocol = Boolean(parseError) ||
    (parsed.hasProtocol && (parsed.errors.length > 0 || (calls.length === 0 && parsed.text === '')));

  if (toolsDisabled && (unexpectedCalls || malformedProtocol)) {
    let recovered = false;
    let lastError = 'Tool use is disabled for this request.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'text')
      }]);
      completion = await requestCompletion(retryMessages, body, signal, provider, providerCapabilities);
      parsed = parseBYVOutput(completion.text);
      if (!parsed.hasProtocol && parsed.calls.length === 0 && parsed.errors.length === 0) {
        calls = [];
        recovered = true;
        break;
      }
      lastError = parsed.errors[0] || 'The model attempted to call a tool while tool use was disabled.';
    }
    if (!recovered) {
      throw Object.assign(new Error('Model continued to emit BYV tool markup while tool use was disabled. No tool call was forwarded.'), {
        statusCode: 502, type: 'api_error', code: 'BYV_TEXT_RECOVERY_FAILED'
      });
    }
  } else if (tools.length > 0 && (
    parseError ||
    parsed.errors.length > 0 ||
    (calls.length > 0 && !validation.valid) ||
    (exactBashCommand !== null && calls.length === 0)
  )) {
    let recovered = false;
    let lastError = validation.error || parseError || 'Malformed BYV output.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'tool', { nativeToolCalling: PROVIDER_NATIVE_TOOL_CALLING })
      }]);
      completion = await requestCompletion(retryMessages, body, signal, provider, providerCapabilities);
      if (completion.text.length > MAX_OUTPUT_CHARS) {
        lastError = 'The recovery output exceeded the configured maximum size.';
        continue;
      }
      parsedResult = parseCompletionToolCalls(completion);
      parsed = parsedResult.parsed;
      calls = parsedResult.calls;
      validation = validateToolCallRequest(calls, tools, force, exactBashCommand);
      if (!validation.valid && parsedResult.error) {
        validation.error = parsedResult.error + ' ' + validation.error;
      }
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
          content: buildRecoveryMessage(lastError, attempt, 'tool', { nativeToolCalling: PROVIDER_NATIVE_TOOL_CALLING })
        }]);
        completion = await requestCompletion(retryMessages, body, signal, provider, providerCapabilities);
        parsedResult = parseCompletionToolCalls(completion);
        parsed = parsedResult.parsed;
        calls = parsedResult.calls;
        validation = validateToolCallRequest(calls, tools, force, exactBashCommand);
        if (!validation.valid && parsedResult.error) {
          validation.error = parsedResult.error + ' ' + validation.error;
        }
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
    const finalValidation = validateToolCallRequest(calls, tools, force, exactBashCommand);
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
  normalizeUsage,
  hasProviderTokenTotals,
  enforceProviderBudget,
  parseCompletionToolCalls
};