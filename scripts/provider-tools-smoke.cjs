'use strict';

// Live provider-level check for OpenAI-compatible native function calling.
// Run: npm run test:provider-tools
// This test asks the model to call a harmless synthetic tool. It never executes the tool.

const assert = require('node:assert/strict');
const { PROVIDER_MODEL, DSML_TOOL_CALL } = require('../src/config');
const { createChatCompletion } = require('../src/provider/openai-compatible');
const { buildProviderMessages } = require('../src/prompts');

const tools = [{
  name: 'Read',
  description: 'Synthetic test function. Request the contents of a file by its path. This function is never executed.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The exact path to read.'
      }
    },
    required: ['file_path'],
    additionalProperties: false
  }
}];

async function main() {
  console.log('BYV native provider function-calling smoke test');
  console.log('Provider model:', PROVIDER_MODEL || '(configured model not found)');
  console.log('Gateway DSML_TOOL_CALL setting:', DSML_TOOL_CALL);
  console.log('Scope: direct provider-native function calling; this probe bypasses the gateway transport switch.');

  const request = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    tools,
    tool_choice: 'auto',
    messages: [{
      role: 'user',
      content: 'Use the Read tool to inspect README.md. Call it now with file_path exactly "README.md". Do not describe or simulate a call in plain text.'
    }]
  };
  // Reuse the same native-mode system prompt and model profile as the gateway.
  // This keeps the direct provider probe representative of a real BYV request.
  const providerMessages = buildProviderMessages(request, {
    nativeToolCalling: true,
    noToolExperiment: false,
    experimentVariant: 'A'
  });
  const result = await createChatCompletion(providerMessages, {
    max_tokens: 1024,
    tools,
    tool_choice: 'auto',
    nativeToolCalling: true
  });

  const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  assert.equal(calls.length, 1,
    'Expected one structured native tool call. Raw ATEM/text output is not a native tool_calls response. Provider response metadata: ' +
    JSON.stringify({
      provider_model: result.provider_model,
      finish_reason: result.finish_reason,
      tool_call_count: calls.length,
      text: result.text || '(empty)'
    }));
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].function && calls[0].function.name, 'Read');
  const input = JSON.parse(calls[0].function.arguments);
  assert.deepEqual(input, { file_path: 'README.md' });

  console.log('PASS native auto tool calling:', calls[0].function.name, JSON.stringify(input));
  console.log('PASS provider emitted a structured function call; no tool was executed.');
}

main().catch((error) => {
  console.error('BYV native provider function-calling smoke test FAILED');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
