'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, MAX_PROMPT_CHARS } = require('./config');
const { flattenText } = require('./content');
const { modelProfilePrompt } = require('./model-profiles');

const TEMPLATE_PATH = path.join(ROOT_DIR, 'system', 'BYV_SYSTEM_PROMPT_TEMPLATE_v0.1.txt');
const BASE_TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

function serializeTool(tool) {
  return JSON.stringify({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.input_schema
  }, null, 2);
}

function toolsToPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [
      'No tools are available for this request.',
      'Do not emit BYV calls, invoke, or parameter tags. Use TEXT mode.',
      'Do not invent tools or imply that a tool was executed.'
    ].join('\n');
  }
  return [
    'The following tools are the complete allowlist for this request. Do not invent tools.',
    ...tools.map((tool, index) => 'TOOL ' + (index + 1) + '\n' + serializeTool(tool)),
    '',
    'Use the exact tool name and parameter names from these schemas.',
    'Validate your own arguments against required fields, types, enum values, and constraints before emitting a call.',
    'Use one outer BYV calls block for the entire tool response and one invoke per requested tool.',
    'Use parameter type="string" for raw UTF-8 strings. Escape backslash as \\\\, line feed as \\n, carriage return as \\r, tab as \\t, and a literal closing parameter token as \\</|BYV| parameter>.',
    'For number, boolean, null, array, and object parameters, use the matching type and exactly one valid JSON value.',
    'Do not put prose or Markdown inside a calls block. Never use legacy TOOL_CALL JSON wrappers.',
    'A tool call requests an action. It does not mean the action has been executed.'
  ].join('\n');
}

function effortPrompt(effort) {
  const guidance = {
    low: 'Keep reasoning and response depth focused. Do not skip required validation or safety checks.',
    medium: 'Use balanced reasoning depth appropriate to the task.',
    high: 'Use thorough reasoning for meaningful edge cases, trade-offs, and verification.',
    xhigh: 'Use very thorough analysis for complex tasks while remaining focused on the requested outcome.',
    max: 'Use the deepest useful analysis available. Avoid unnecessary verbosity in the final response.'
  };
  return guidance[effort] ? '=== RESPONSE EFFORT ===\n' + guidance[effort] : '';
}

function toolChoicePrompt(choice, tools) {
  if (!choice || choice === 'auto' || choice.type === 'auto') return '';
  const mode = typeof choice === 'string' ? choice : choice.type;
  if (mode === 'none') {
    return [
      '=== STOP: DO NOT CALL TOOLS ===',
      'Tools are disabled for this turn. Do not emit BYV markup or legacy tool-call wrappers.',
      'Use only information already available and answer in plain text. If information is incomplete, state the limitation.'
    ].join('\n');
  }
  if (mode === 'any') {
    return '=== REQUIRED TOOL USE ===\nYou must call at least one available tool. Respond with one complete BYV calls block and no prose outside it.';
  }
  if (mode === 'tool') {
    return '=== REQUIRED TOOL USE ===\nYou must call the tool named ' + choice.name + '. Do not call a different tool. Respond with one complete BYV calls block.';
  }
  return '';
}

function buildSystemPrompt(body) {
  const requestSystem = flattenText(body.system);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const availableTools = toolsToPrompt(tools);
  let system = BASE_TEMPLATE.replace('{{AVAILABLE_TOOLS}}', availableTools);
  const additions = [];
  if (requestSystem) additions.push('=== REQUEST SYSTEM INSTRUCTIONS ===\n' + requestSystem);
  additions.push(modelProfilePrompt(body.model));
  const effort = effortPrompt(body.output_config && body.output_config.effort);
  if (effort) additions.push(effort);
  const choice = toolChoicePrompt(body.tool_choice, tools);
  if (choice) additions.push(choice);
  system += '\n\n' + additions.filter(Boolean).join('\n\n');

  if (system.length > MAX_PROMPT_CHARS) {
    system = system.slice(0, MAX_PROMPT_CHARS) +
      '\n\n[BYV NOTE: system prompt was truncated at the configured character limit.]';
  }
  return system;
}

function buildProviderMessages(body) {
  const { convertAnthropicMessages } = require('./content');
  return [
    { role: 'system', content: buildSystemPrompt(body) },
    ...convertAnthropicMessages(body.messages)
  ];
}

function buildRecoveryMessage(error, attempt, mode) {
  if (mode === 'text') {
    return [
      'RECOVERY REQUIRED: the previous output attempted a tool call even though tool use is disabled.',
      'Do not emit any BYV or legacy tool-call markup. Do not request or claim tool execution.',
      'Answer in plain text using only the existing conversation and available results.',
      'If the answer cannot be completed from available information, state that clearly.',
      'This is a correction of formatting and policy, not a new user task.'
    ].join('\n');
  }
  return [
    'RECOVERY REQUIRED: the previous BYV tool-call output was invalid or did not satisfy the declared schema.',
    'Do not copy malformed markup or invalid arguments. Rebuild the required call from the original user request and available tool schemas.',
    'Validation issue: ' + String(error || 'Unknown BYV validation error'),
    'Output exactly one complete BYV calls block. Use one invoke per call and use the declared attribute order and parameter types.',
    'Every invoke must have a unique non-empty id. Every argument must satisfy its tool input_schema.',
    attempt >= 2
      ? 'This is the final recovery attempt. Prefer the smallest valid call that still fulfills the request.'
      : 'Preserve the original intent. Do not invent missing values.'
  ].join('\n');
}

module.exports = {
  BASE_TEMPLATE,
  toolsToPrompt,
  effortPrompt,
  buildSystemPrompt,
  buildProviderMessages,
  buildRecoveryMessage
};