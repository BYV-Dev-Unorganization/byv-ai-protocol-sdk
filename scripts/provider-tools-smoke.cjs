'use strict';

// Live provider-level check for OpenAI-compatible native function calling.
// Run: npm run test:provider-tools
// This test asks the model to call a harmless synthetic tool. It never executes the tool.

const assert = require('node:assert/strict');
const { PROVIDER_MODEL, DSML_TOOL_CALL } = require('../src/config');
const { createChatCompletion } = require('../src/provider/openai-compatible');

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

  const result = await createChatCompletion([
    {
      role: 'system',
      content: 'You are testing native function calling. The Read function is a synthetic fixture and will not be executed. When explicitly asked to use it, call it through the native function tool interface. Do not merely say that you will use it.'
    },
    {
      role: 'user',
      content: 'Use the Read function now with file_path exactly "README.md". Return the function call and do not answer in plain text.'
    }
  ], {
    max_tokens: 256,
    tools,
    tool_choice: 'auto'
  });

  const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  assert.equal(calls.length, 1,
    'Expected exactly one native tool call. Provider text response: ' + (result.text || '(empty)'));
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
