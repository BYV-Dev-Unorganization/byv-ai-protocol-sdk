'use strict';

// Keep the test suite independent from a developer's local .env transport.
// DSML-focused tests run against the repository's default mode; native-mode
// tests opt in explicitly with noToolExperiment: false.
process.env.DSML_TOOL_CALL = 'true';
