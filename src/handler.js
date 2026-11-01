'use strict';

const { MAX_RECOVERY_ATTEMPTS, MAX_OUTPUT_CHARS, uuid, approxTokens } = require('./config');
const { buildProviderMessages, buildRecoveryMessage } = require('./prompts');
const { createChatCompletion, createStreamingChatCompletion } = require('./provider/openai-compatible');
const { parseBYVOutput } = require('./protocol/parser');
const { validateToolCalls } = require('./tools/validator');
const { estimateInputTokens, estimateOutputTokens } = require('./content');

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

function normalizeUsage(providerUsage, inputEstimate, outputEstimate) {
  const input = providerUsage && Number.isInteger(providerUsage.prompt_tokens)
    ? providerUsage.prompt_tokens
    : inputEstimate;
  const output = providerUsage && Number.isInteger(providerUsage.completion_tokens)
    ? providerUsage.completion_tokens
    : outputEstimate;
  return { input_tokens: input, output_tokens: output };
}

async function requestCompletion(messages, body, signal) {
  const options = {
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop_sequences
  };
  return body.stream === true
    ? createStreamingChatCompletion(messages, options, signal)
    : createChatCompletion(messages, options, signal);
}

async function handleMessages(body, options = {}) {
  const signal = options.signal;
  const model = body.model;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const force = parseToolChoice(body.tool_choice);
  const inputTokens = estimateInputTokens(body);
  const providerMessages = buildProviderMessages(body);
  let completion = await requestCompletion(providerMessages, body, signal);

  if (completion.text.length > MAX_OUTPUT_CHARS) {
    throw Object.assign(new Error('Provider output exceeded the configured maximum size.'), {
      statusCode: 502, type: 'api_error', code: 'PROVIDER_OUTPUT_TOO_LARGE'
    });
  }

  let parsed = parseBYVOutput(completion.text);
  let calls = parsed.calls;
  let parseError = parsed.errors[0] || null;
  let validation = calls.length > 0
    ? validateToolCalls(calls, tools)
    : { valid: false, error: parseError || 'The model did not return a BYV tool call.' };

  if (validation.valid && calls.length > 0) {
    validation = validateChoice(calls, force);
  }

  const toolsDisabled = force.mode === 'none' || tools.length === 0;
  const unexpectedCalls = calls.length > 0 && toolsDisabled;
  const malformedProtocol = parsed.hasProtocol && (parsed.errors.length > 0 || calls.length === 0);

  if (toolsDisabled && (unexpectedCalls || malformedProtocol)) {
    let recovered = false;
    let lastError = 'Tool use is disabled for this request.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'text')
      }]);
      completion = await requestCompletion(retryMessages, body, signal);
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
  } else if (tools.length > 0 && (parsed.errors.length > 0 || (calls.length > 0 && !validation.valid))) {
    let recovered = false;
    let lastError = validation.error || parseError || 'Malformed BYV output.';
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      const retryMessages = providerMessages.concat([{
        role: 'user',
        content: buildRecoveryMessage(lastError, attempt, 'tool')
      }]);
      completion = await requestCompletion(retryMessages, body, signal);
      if (completion.text.length > MAX_OUTPUT_CHARS) {
        lastError = 'The recovery output exceeded the configured maximum size.';
        continue;
      }
      parsed = parseBYVOutput(completion.text);
      calls = parsed.calls;
      validation = calls.length > 0
        ? validateToolCalls(calls, tools)
        : { valid: false, error: parsed.errors[0] || 'The recovery did not return a tool invocation.' };
      if (validation.valid && calls.length > 0) validation = validateChoice(calls, force);
      if (parsed.errors.length === 0 && validation.valid && calls.length > 0) {
        recovered = true;
        break;
      }
      lastError = validation.error || parsed.errors[0] || 'The recovery did not return a valid BYV call.';
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
          content: buildRecoveryMessage(lastError, attempt, 'tool')
        }]);
        completion = await requestCompletion(retryMessages, body, signal);
        parsed = parseBYVOutput(completion.text);
        calls = parsed.calls;
        validation = calls.length ? validateToolCalls(calls, tools) : { valid: false, error: 'No invocation returned.' };
        if (validation.valid && calls.length) validation = validateChoice(calls, force);
        if (parsed.errors.length === 0 && validation.valid && calls.length) {
          recovered = true;
          break;
        }
        lastError = validation.error || parsed.errors[0] || 'No valid tool call returned.';
      }
      if (!recovered) {
        throw Object.assign(new Error('The model did not produce the tool call required by tool_choice.'), {
          statusCode: 502, type: 'api_error', code: 'BYV_REQUIRED_TOOL_MISSING'
        });
      }
    }
  }

  if (calls.length > 0) {
    const finalValidation = validateToolCalls(calls, tools);
    if (!finalValidation.valid) {
      throw Object.assign(new Error('Tool calls were rejected: ' + finalValidation.error), {
        statusCode: 502, type: 'api_error', code: 'BYV_TOOL_VALIDATION_FAILED'
      });
    }
    const choiceValidation = validateChoice(calls, force);
    if (!choiceValidation.valid) {
      throw Object.assign(new Error('Tool calls were rejected: ' + choiceValidation.error), {
        statusCode: 502, type: 'api_error', code: 'BYV_TOOL_CHOICE_MISMATCH'
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
      (completion.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
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
  result.usage = normalizeUsage(completion.usage, inputTokens, outputEstimate);
  result.usage_estimated = !(completion.usage &&
    Number.isInteger(completion.usage.prompt_tokens) &&
    Number.isInteger(completion.usage.completion_tokens));
  return result;
}

module.exports = { handleMessages, parseToolChoice, validateChoice, normalizeUsage };