'use strict';

const { spawnSync } = require('node:child_process');

const modes = [
  { name: 'DSML_TOOL_CALL=true', value: 'true' },
  { name: 'DSML_TOOL_CALL=false', value: 'false' }
];

let failed = false;
for (const mode of modes) {
  process.stdout.write('\n===== Running test suite with ' + mode.name + ' =====\n');
  const result = spawnSync(process.execPath, ['--test'], {
    stdio: 'inherit',
    env: { ...process.env, DSML_TOOL_CALL: mode.value }
  });
  if (result.error) {
    process.stderr.write(result.error.stack || result.error.message);
    failed = true;
    continue;
  }
  if (result.status !== 0) {
    process.stderr.write('\nTest suite failed with ' + mode.name + '.\n');
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
