'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BASE_TEMPLATE,
  toolsToPrompt,
  buildFullPrompt,
  buildResumePrompt,
  buildSystemPrompt,
  buildProviderMessages,
  buildCompactionProviderMessages,
  parseToolChoice,
  applyForcedTool,
  buildRecoveryMessage
} = require('../src/prompts');
const { PROVIDER_NATIVE_TOOL_CALLING } = require('../src/config');
const { estimateProviderInputTokens } = require('../src/content');

const PROMPT_ARTIFACT_PATH = path.join(
  __dirname,
  '..',
  'system',
  'BYV_SYSTEM_PROMPT_ARTIFACT_v0.2.txt'
);

const readTool = {
  name: 'Read',
  description: 'Read a file from the workspace',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or workspace-relative file path' }
    },
    required: ['file_path'],
    additionalProperties: false
  }
};

const bashTool = {
  name: 'Bash',
  description: 'Run a shell command in the workspace',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' }
    },
    required: ['command'],
    additionalProperties: false
  }
};

test('base prompt and documentation artifact describe DSML model output and the internal BYV adapter', () => {
  const artifact = fs.readFileSync(PROMPT_ARTIFACT_PATH, 'utf8');
  assert.match(BASE_TEMPLATE, /ASSISTANT IDENTITY/);
  assert.match(BASE_TEMPLATE, /CONVERSATION LANGUAGE/);
  assert.match(BASE_TEMPLATE, /DSML TOOL CALLS/);
  assert.match(BASE_TEMPLATE, /DeepSeek DSML is the model-facing tool-call format/);
  assert.match(BASE_TEMPLATE, /string flags/);
  assert.match(artifact, /DeepSeek DSML/);
  assert.match(artifact, /<｜DSML｜ calls>/);
  assert.doesNotMatch(BASE_TEMPLATE, /BYV Format Block/);
  assert.match(artifact, /unchanged BYV protocol parser/);
});

test('tool prompt follows the reference catalog style and describes exact DSML syntax', () => {
  const prompt = toolsToPrompt([bashTool, readTool]);
  assert.match(prompt, /Bash\(command\*: string/);
  assert.match(prompt, /Read\(file_path\*: string/);
  assert.match(prompt, /DeepSeek DSML markup format/);
  assert.match(prompt, /<｜DSML｜ invoke name="Bash">/);
  assert.match(prompt, /<｜DSML｜ parameter name="command" string="true">pwd/);
  assert.match(prompt, /string="false"/);
  assert.match(prompt, /preserve it verbatim/);
  assert.match(prompt, /Tool names, descriptions, and schemas define available capabilities/);
  assert.doesNotMatch(prompt, /BYV Format Block/);
  assert.match(prompt, /string="true"/);
  assert.equal(toolsToPrompt([]), '');
});

test('buildSystemPrompt combines client system context, project policy, tools, profile, and runtime controls', () => {
  const prompt = buildSystemPrompt({
    model: 'claude-sonnet-5-5',
    system: 'Keep the answer concise.',
    tools: [readTool],
    tool_choice: { type: 'tool', name: 'Read' }
  });
  assert.ok(prompt.indexOf('### SYSTEM') >= 0);
  assert.ok(prompt.indexOf('Keep the answer concise.') >= 0);
  assert.ok(prompt.indexOf('ASSISTANT IDENTITY') >= 0);
  assert.ok(prompt.indexOf('### TOOLS') >= 0);
  assert.ok(prompt.indexOf('Read(file_path*: string') >= 0);
  assert.ok(prompt.indexOf('=== ACTIVE GATEWAY TOOL-CHOICE CONTROL ===') >= 0);
  assert.ok(prompt.indexOf('MODEL RESPONSE PROFILE') >= 0);
  assert.match(prompt, /DeepSeek DSML tool-call format as the model-facing text protocol/);
  assert.match(prompt, /DSML/i);
});

test('DSML prompt includes the complete nested JSON Schema as the authoritative tool contract', () => {
  const schemaTool = {
    name: 'mcp__example__search',
    description: 'Search records',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['exact', 'fuzzy'] },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } },
            required: ['field']
          }
        }
      },
      required: ['mode']
    }
  };
  const prompt = buildSystemPrompt({ tools: [schemaTool] }, { nativeToolCalling: false });
  assert.match(prompt, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.match(prompt, /"enum": \[\s*"exact",\s*"fuzzy"/);
  assert.match(prompt, /"items": \{/);
  assert.match(prompt, /"required": \[\s*"mode"/);
});

test('buildSystemPrompt forbids invented tool calls when no tools are declared', () => {
  const prompt = buildSystemPrompt({ model: 'byv-flash-v1', tools: [], messages: [{ role: 'user', content: 'Run pwd.' }] });
  assert.match(prompt, /NO TOOLS AVAILABLE/);
  assert.match(prompt, /Do not emit DSML calls, invoke, or parameter tags/);
  assert.match(prompt, /Do not invent tools/);
});

test('buildSystemPrompt gives the latest tool result continuation the original task and next-step rules', () => {
  const prompt = buildSystemPrompt({
    model: 'byv-flash-v1',
    tools: [readTool],
    messages: [
      { role: 'user', content: 'Read README.md and summarize it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'README contents' }] }
    ]
  });
  assert.match(prompt, /ORIGINAL USER REQUEST/);
  assert.match(prompt, /Read README\.md and summarize it\./);
  assert.match(prompt, /INSTRUCTIONS AFTER TOOL RESULTS/);
  assert.match(prompt, /Do not call another tool if the task is complete/);
});

test('buildFullPrompt and buildResumePrompt retain DSML protocol across new requests and tool-result turns', () => {
  const messages = [
    { role: 'user', content: 'Read README.md and summarize it.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'README contents' }] }
  ];
  const full = buildFullPrompt('Client instructions', messages, [readTool]);
  const resume = buildResumePrompt('Client instructions', messages, [readTool], true);
  assert.match(full, /DSML calls\/invoke\/parameter format/);
  assert.match(full, /=== TOOL RESULTS ===/);
  assert.match(resume, /LATEST TOOL RESULTS/);
  assert.match(resume, /ORIGINAL USER REQUEST/);
  assert.match(resume, /DSML calls block/);
  assert.match(full + resume, /DSML/i);
});

test('buildProviderMessages preserves provider chat roles while applying the new DSML system prompt', () => {
  const messages = buildProviderMessages({
    model: 'byv-flash-v1',
    tools: [readTool],
    messages: [
      { role: 'user', content: 'Read README.md.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'file content' }] }
    ]
  }, { nativeToolCalling: false });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /DSML TOOL CALL PROTOCOL/);
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[2].role, 'assistant');
  assert.match(messages[2].content, /HISTORICAL TOOL INVOCATIONS/);
  assert.match(messages[2].content, /<｜DSML｜tool_calls>/);
  assert.equal(messages[3].role, 'user');
  assert.match(messages[3].content, /HISTORICAL TOOL RESULTS/);
  assert.match(messages[3].content, /file content/);
  assert.equal(messages.some((message) => message.role === 'tool'), false);
});


test('buildCompactionProviderMessages creates a bounded provider-neutral transcript', () => {
  const messages = [
    { role: 'user', content: 'Original task: implement the feature and preserve its requirements.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_old', name: 'Read', input: { file_path: 'old.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_old', content: 'O'.repeat(40000) }] },
    { role: 'assistant', content: 'The earlier output has been reviewed.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'Recent README result.' }] },
    { role: 'assistant', content: 'The latest repository details are ready for summary.' },
    { role: 'user', content: [
      'CRITICAL: Do not call tools. Return an <analysis> followed by a <summary>. Summarize the conversation.'
    ].join('\n') }
  ];
  const system = 'External system/developer instructions. '.repeat(1200);
  const providerMessages = buildCompactionProviderMessages({
    model: 'claude-opus-5-5',
    system,
    tools: [readTool],
    messages
  }, { maxInputTokens: 12000 });

  assert.equal(providerMessages.length, 2);
  assert.equal(providerMessages[0].role, 'system');
  assert.equal(providerMessages[1].role, 'user');
  assert.match(providerMessages[0].content, /TEXT-ONLY OUTPUT CONTRACT/);
  assert.match(providerMessages[0].content, /MODEL RESPONSE PROFILE/);
  assert.ok(providerMessages[0].content.includes('External system/developer instructions'));
  assert.match(providerMessages[1].content, /Original task: implement the feature/);
  assert.match(providerMessages[1].content, /Tool call Read/);
  assert.match(providerMessages[1].content, /Tool result for call_read/);
  assert.match(providerMessages[1].content, /CRITICAL: Do not call tools/);
  assert.match(providerMessages[1].content, /older conversation history omitted/);
  assert.ok(providerMessages[0].content.length < 30000);
  assert.ok(providerMessages[1].content.length < 25000);
  assert.ok(estimateProviderInputTokens(providerMessages) <= 12000);
  assert.equal(providerMessages[0].content.includes('AUTHORITATIVE TOOL INPUT SCHEMAS'), false);
  assert.equal(providerMessages[1].content.includes('AUTHORITATIVE TOOL INPUT SCHEMAS'), false);
});

test('parseToolChoice and applyForcedTool preserve none, any, and named-tool controls', () => {
  assert.deepEqual(parseToolChoice('none'), { mode: 'none' });
  assert.deepEqual(parseToolChoice('any'), { mode: 'any' });
  assert.deepEqual(parseToolChoice({ type: 'tool', name: 'Read' }), { mode: 'tool', name: 'Read' });
  const none = applyForcedTool('base prompt', { mode: 'none' });
  const any = applyForcedTool('base prompt', { mode: 'any' });
  const specific = applyForcedTool('base prompt', { mode: 'tool', name: 'Read' });
  assert.match(none, /STOP: DO NOT CALL TOOLS/);
  assert.match(none, /Do NOT call any tools/);
  if (PROVIDER_NATIVE_TOOL_CALLING) {
    assert.match(any, /native function/);
    assert.match(specific, /native function/);
  } else {
    assert.match(any, /one DSML calls block/);
    assert.match(specific, /one DSML calls block containing an invoke named "Read"/);
  }
});


test('native-disabled recovery identifies the protocol mismatch and safely includes rejected call context', () => {
  const message = buildRecoveryMessage(
    'Native provider function calls are disabled; use DSML text tool calls instead.',
    1,
    'tool',
    {
      nativeToolCalling: false,
      failureKind: 'provider_native_disabled',
      rejectionReason: 'PROVIDER_NATIVE_DISABLED',
      rejectedToolCalls: [{
        name: 'Bash',
        input: {
          command: 'git worktree list',
          api_key: 'secret-value-must-not-appear',
          headers: { Authorization: 'Bearer example-sensitive-token' }
        }
      }]
    }
  );
  assert.match(message, /provider-native function call/i);
  assert.match(message, /PROVIDER_NATIVE_DISABLED/);
  assert.match(message, /was NOT executed/i);
  assert.match(message, /"tool_name": "Bash"/);
  assert.match(message, /git worktree list/);
  assert.match(message, /\[REDACTED\]/);
  assert.doesNotMatch(message, /secret-value-must-not-appear/);
  assert.doesNotMatch(message, /example-sensitive-token/);
  assert.match(message, /untrusted diagnostic data/i);
  assert.match(message, /one DeepSeek DSML calls block/);
});

test('recovery prompts include the validation issue, concrete DSML example, and final-attempt guidance', () => {
  const validationIssue = 'BYV parameter command is not closed.';
  const firstRecovery = buildRecoveryMessage(validationIssue, 1, 'tool');
  const finalRecovery = buildRecoveryMessage('Retry returned a malformed batch.', 2, 'tool');
  const textRecovery = buildRecoveryMessage('tool disabled', 1, 'text');

  if (PROVIDER_NATIVE_TOOL_CALLING) {
    assert.match(firstRecovery, /native function-calling interface/);
    assert.ok(firstRecovery.includes('Correct this issue: BYV parameter command is not closed.'));
    assert.match(finalRecovery, /final recovery attempt/i);
  } else {
    assert.match(firstRecovery, /=== TOOL CALL RECOVERY ===/);
    assert.match(firstRecovery, /previous response contained a tool call/i);
    assert.ok(firstRecovery.includes('Correct this issue: BYV parameter command is not closed.'));
    assert.match(firstRecovery, /one DeepSeek DSML calls block/);
    assert.ok(firstRecovery.includes('<｜DSML｜ calls><｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>'));
    assert.match(firstRecovery, /preserve.*verbatim/i);
    assert.doesNotMatch(firstRecovery, /final recovery attempt/i);

    assert.match(finalRecovery, /previous recovery retry returned a partially malformed or invalid tool-call batch/i);
    assert.ok(finalRecovery.includes('Correct this issue: Retry returned a malformed batch.'));
    assert.match(finalRecovery, /final recovery attempt/i);
  }

  assert.match(textRecovery, /Do not emit DSML calls/);
  assert.doesNotMatch(textRecovery, /Output exactly one complete DSML calls block/);
});


test('text-only inference uses the DeepSeek-style consolidated DSML prompt without native tool schemas', () => {
  const request = {
    model: 'byv-flash-v1',
    system: 'Follow the repository instructions.',
    tools: [readTool],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'Read README.md.' }]
  };

  const systemPrompt = buildSystemPrompt(request, {
    noToolExperiment: true,
    experimentVariant: 'B',
    nativeToolCalling: true
  });
  assert.match(systemPrompt, /DSML TOOL CALL PROTOCOL/);
  assert.match(systemPrompt, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.doesNotMatch(systemPrompt, /NATIVE TOOL CALL PROTOCOL/);
  assert.doesNotMatch(systemPrompt, /TEXT-ONLY OUTPUT CONTRACT/);

  const providerMessages = buildProviderMessages(request, {
    noToolExperiment: true,
    experimentVariant: 'B',
    nativeToolCalling: true
  });
  assert.equal(providerMessages.length, 1);
  assert.equal(providerMessages[0].role, 'user');
  assert.match(providerMessages[0].content, /### SYSTEM/);
  assert.match(providerMessages[0].content, /Follow the repository instructions/);
  assert.match(providerMessages[0].content, /### TOOLS/);
  assert.ok(providerMessages[0].content.includes('Read(file_path*: string'));
  assert.match(providerMessages[0].content, /AUTHORITATIVE TOOL INPUT SCHEMAS/);
  assert.match(providerMessages[0].content, /### LATEST USER MESSAGE/);
  assert.match(providerMessages[0].content, /DeepSeek DSML markup format/);
  assert.doesNotMatch(providerMessages[0].content, /NATIVE TOOL CALL PROTOCOL/);
});;
