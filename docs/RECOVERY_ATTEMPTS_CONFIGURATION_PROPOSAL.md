# Proposal: Align Recovery Prompts With the Configured Retry Limit

**Status:** Draft proposal, not implemented  
**Scope:** Future follow-up for `MAX_RECOVERY_ATTEMPTS`

## Current behavior

The gateway currently defines:

```js
const MAX_RECOVERY_ATTEMPTS = boundedInteger('MAX_RECOVERY_ATTEMPTS', 2, 0, 5);
```

The default is **2 recovery attempts**. The environment variable can currently override that value from 0 through 5. The handler uses this setting to control the recovery loop.

The recovery prompt currently marks an attempt as the final attempt when `attempt >= 2`. This matches the default configuration, but it does not stay aligned when the environment override is changed:

- `MAX_RECOVERY_ATTEMPTS=1`: the only recovery prompt is not identified as the final attempt.
- `MAX_RECOVERY_ATTEMPTS=3` (or 4 or 5): the second recovery prompt is incorrectly identified as the final attempt.
- `MAX_RECOVERY_ATTEMPTS=0`: no recovery retry is performed, so no recovery prompt should be generated.

For now, keep the default at **2** and retain the current retry behavior. This proposal records a future consistency improvement only.

## Proposed change

Make the recovery prompt derive its final-attempt wording from the same configured maximum that controls the handler loop.

A future implementation should:

1. Make the configured maximum available to `buildRecoveryMessage()`, either through an explicit options argument or a narrowly scoped import from configuration.
2. Compute the final-attempt condition as `maxAttempts > 0 && attempt >= maxAttempts`.
3. Use that condition consistently for DSML recovery and the optional native function-calling recovery path.
4. Keep the distinction between the initial malformed response and a malformed subsequent recovery response. The prompt should describe the actual previous response, not assume every failure came from a retry.
5. Avoid changing the meaning of the setting: it counts retries after the initial model response, not total provider attempts.

## Expected behavior after a future implementation

| Configured retries | Recovery prompts | Final-attempt wording |
| ---: | ---: | --- |
| 0 | 0 | No recovery prompt |
| 1 | 1 | Attempt 1 |
| 2 | 2 | Attempt 2 |
| 3 | 3 | Attempt 3 |
| 5 | 5 | Attempt 5 |

For the current default of 2, the overall flow remains one initial provider response plus at most two recovery responses.

## Test coverage to add with the future change

- Verify that retry 1 is marked final when the configured maximum is 1.
- Verify that retry 2 is marked final when the configured maximum is 2.
- Verify that retry 3 is marked final when the configured maximum is 3.
- Verify that retry 5 is marked final when the configured maximum is 5.
- Verify that no recovery prompt is generated when the configured maximum is 0.
- Verify equivalent final-attempt wording for DSML and native tool-calling recovery.
- Verify that the wording for the previous response distinguishes the initial response from a failed recovery retry.

## Non-goals

- Do not increase the current default retry count.
- Do not change the parser, DSML-to-BYV adapter, schema validation, or recovery loop semantics as part of this proposal.
- Do not automatically retry calls that may already have produced side effects.
