# Testing

The default test command is intentionally a two-mode regression matrix.

## Unit/regression suite

Run:

```sh
npm test
```

The script `scripts/run-tests.js` launches Node's test runner twice:

```text
DSML_TOOL_CALL=true
DSML_TOOL_CALL=false
```

The current regression contract is therefore independent of the developer's local `.env` value.

Both runs must exit successfully for `npm test` to pass.

Verified baseline for the current feature branch:

- 208 tests passing in DSML mode;
- 208 tests passing in native mode;
- 0 failures in either mode.

## Syntax checks

Run:

```sh
npm run check
```

This validates JavaScript syntax for the main runtime modules and smoke-test scripts.

## Live smoke tests

These commands require a running gateway and/or a real configured upstream provider. They are intentionally separate from `npm test`.

### Anthropic SDK

```sh
npm run test:sdk
```

Checks the official Anthropic SDK against the local gateway, including Messages, token counting, streaming, and tool-use round trips.

### Provider-native tools

```sh
npm run test:provider-tools
```

Checks whether the configured upstream provider can return a structured native function call.

The synthetic tool is not executed.

### Claude Code

```sh
npm run test:claude-code
```

Runs a restricted Claude Code CLI smoke test against the local gateway. The test uses an isolated workspace and a narrow six-tool allowlist.

The smoke tests may consume provider quota and are not deterministic offline unit tests.

## What to test after changing tool transport

Changes to tool transport, prompt generation, provider mapping, or recovery should pass both:

```text
DSML_TOOL_CALL=true
DSML_TOOL_CALL=false
```

A test that only passes in the developer's current environment is not sufficient because the two modes intentionally use different provider-facing protocols.

## CI

The GitHub Actions test workflow runs the same deterministic test command. The repository therefore protects the tool transport switch with the same two-mode regression contract locally and in CI.
