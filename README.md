# jev-effort-router

A Claude Code plugin that picks the reasoning effort for each prompt. It sends the prompt to [TypeSafe](https://typesafe.ai)'s Jev decision model, which answers `low`, `medium`, `high` or `xhigh`, and runs that turn at that effort. The model is never changed.

- Effort is set per request at `turn.step`, so your own effort setting is never changed. A turn the router leaves alone runs on it as usual.
- Both directions: a mechanical prompt is routed down, a hard one up. Raising needs confidence ≥ 0.3; lowering needs ≥ 0.6, because too little effort costs more than too much.
- If Jev reads the task as one that would itself change production, move money or destroy data, the turn gets at least `high`.
- Fail-open: an error or a reply slower than the time budget leaves the turn unchanged.
- `/auto-effort on|off|status` switches it, remembered across sessions. Off, nothing is sent.

## Requirements

- Claude Code 2.1.259 or later, with function hooks on: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (in your shell, or under `env` in `~/.claude/settings.json`).
- A TypeSafe API key. Without one the plugin falls back to Claude Code's built-in classifier, which reports no confidence and so can only raise effort.

## Install

```
/plugin marketplace add eSaadster/jev-effort-router
/plugin install jev-effort-router@jev-effort-router
```

Then set the key with `/plugin configure jev-effort-router@jev-effort-router`, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "jev-effort-router@jev-effort-router": {
      "options": { "typesafeApiKey": "<your key>" }
    }
  }
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `typesafeApiKey` | | TypeSafe API key |
| `typesafeBaseUrl` | `https://api.typesafe.ai` | API base URL |
| `typesafeModel` | `jev-latest` | Decision model |
| `maxEffort` | `xhigh` | Highest level the router asks for |
| `minUpgradeConfidence` | `0.3` | Confidence needed to raise effort |
| `minDowngradeConfidence` | `0.6` | Confidence needed to lower effort |
| `timeoutMs` | `3000` | Time budget for a decision |
| `logDecisions` | `true` | Log each decision and show it in the status line |

## Cost and privacy

Each prompt waits for Jev before the turn starts, typically about 1–1.5 s. With a key set, the prompt text (at most about 6,000 characters: the start and the end) is sent to TypeSafe. Nothing else is sent, and nothing at all while routing is off.

## Troubleshooting

Run `claude --debug` and look for `hooks module jev-effort-router@… loaded`. If it says function hooks are off, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. A `ready on the built-in classifier, no key set` line means the key sits under the wrong `pluginConfigs` entry; the key must match the plugin id as installed.

## Tests

```
bun test tests
```

## Credits

Adapted from [jev-model-router](https://github.com/davila7/claude-code-templates) by Daniel Ávila (MIT). The per-level effort question follows a Pi extension that does the same for Codex.
