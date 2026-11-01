'use strict';

const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const options = {
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateSchema: true
};

// Keep the existing default (Draft-07) validator for schemas that omit
// $schema or explicitly use an older dialect. Draft 2020-12 needs Ajv's
// dedicated implementation because its vocabulary and meta-schema differ.
const draft7Validator = addFormats(new Ajv(options));
const draft2020Validator = addFormats(new Ajv2020(options));

function validatorForSchema(schema) {
  const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (/\/draft\/2020-12\/schema#?$/.test(dialect)) {
    return draft2020Validator;
  }
  return draft7Validator;
}

function compileJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('JSON Schema must be an object.');
  }
  return validatorForSchema(schema).compile(schema);
}

module.exports = { compileJsonSchema };
