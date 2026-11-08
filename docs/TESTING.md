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

- 211 tests passing in DSML mode;
- 211 tests passing in native mode;
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

Checks the official Anthropic SDK against the running gateway, including Messages, token counting, streaming, and tool-use round trips. For a local gateway, it reports the active `tool_transport` from `/health`. It uses the gateway mode selected when `npm start` was launched and is expected to pass in both DSML and provider-native modes.

### Provider-native tools

```sh
npm run test:provider-tools
```

Checks whether the configured upstream provider can return a structured native function call. This is a direct provider-adapter probe that bypasses the gateway handler and its `DSML_TOOL_CALL` switch, so its result is independent of the active gateway mode. It specifically verifies provider-native function-calling capability; it does not verify DSML mode.

The synthetic tool is not executed.

### Claude Code

```sh
npm run test:claude-code
```

Runs a restricted Claude Code CLI smoke test against the running gateway. The local preflight reports the active `tool_transport`; the same six-tool flow is expected to work with either DSML or provider-native mode. The test uses an isolated workspace and a narrow six-tool allowlist.

The SDK and Claude Code smoke tests exercise whichever mode the gateway loaded at startup; they do not switch the running gateway between modes automatically. To verify both modes, run the two gateway smoke tests once with `DSML_TOOL_CALL=true`, stop the gateway, change the setting to `false`, restart `npm start`, and run them again. The provider-native provider probe is independent of this switch and can be run in either environment.

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
