# Documentation index

The root [README](../README.md) is the primary entry point for setup, API routes, provider configuration, model profiles, protocol behavior, streaming, security, and development commands.

## Current implementation references

- [Claude Code autocompaction](AUTOCOMPACTION.md) — current request detection, bounded transcript replay, provider-neutral budgets, diagnostics, errors, and limitations.
- [README: Configuration](../README.md#configuration) — complete environment-variable reference.
- [`.env.example`](../.env.example) — copyable configuration template.

## Historical test records and audits

These files record specific revisions or test runs. Their results should not be interpreted as a guarantee for the current revision or every provider/model:

- [NaraRouter provider integration test](NARAROUTER_PROVIDER_TEST.md) — a dated live integration test against a specific provider/model and repository revision.
- [Claude audit findings and recommendations](claude-audit-findings-and-recommendations.md) — a point-in-time audit of the `feat/dsml-prompt-byv-adapter` revision identified inside that document.

## Proposals and follow-up work

These documents contain proposals or historical recommendations, not current implementation guarantees:

- [Recovery attempts configuration proposal](RECOVERY_ATTEMPTS_CONFIGURATION_PROPOSAL.md) — alignment between configured recovery retries and final-attempt prompt wording.
- [Context and token optimization proposal](proposal-context-token-optimization.md) — measurement and optimization ideas from earlier Claude Code testing; bounded autocompaction replay is now documented separately in [AUTOCOMPACTION.md](AUTOCOMPACTION.md).

When a historical audit or proposal conflicts with the current source code or root README, use the current source and README as the implementation reference.
