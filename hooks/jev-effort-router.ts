/**
 * jev-effort-router — Claude Mod (EARLY ACCESS)
 *
 * Picks the reasoning effort of the main loop for each prompt with TypeSafe's
 * Jev, a System One decision model. The model is never touched.
 *
 * The prompt is classified at `prompt.submit`, before the turn starts, and
 * the level is applied at the turn's first request and held for the rest of
 * that turn's tool loop. `turn.step` overrides effort per request, so your
 * configured effort is never changed: a turn left alone runs on it as usual.
 *
 * `/auto-effort on|off|status` switches routing, remembered across sessions
 * in the plugin's own store. Off, nothing is classified and nothing is sent.
 *
 * Every failure path is fail-open: a classification that errors or passes the
 * latency budget leaves the turn exactly as the engine built it.
 *
 * Needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. Typed against
 * https://github.com/anthropics/claude-code/tree/main/mods
 *
 * Privacy: with a key set, the prompt text (at most ~6000 characters) is sent
 * to TypeSafe.
 */
import type { Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  EFFORT_ORDER,
  describeDecision,
  describeSetup,
  describeStatus,
  endpoint,
  isEffort,
  parseToggle,
  pendingDecisions,
  readDecision,
  requestBody,
  requestHeaders,
  route,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig } from './policy.ts'

const COMMAND = 'auto-effort'
const TAG = '[jev-effort-router]'

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  const apiKey = text('typesafeApiKey', '')
  const modelId = text('typesafeModel', DEFAULT_MODEL)
  const url = endpoint(text('typesafeBaseUrl', DEFAULT_BASE_URL))
  const timeoutMs = number('timeoutMs', 3000)
  const logDecisions = flag('logDecisions', true)
  const maxEffortOption = text('maxEffort', 'xhigh')

  const policy: PolicyConfig = {
    maxEffort: isEffort(maxEffortOption) ? maxEffortOption : 'xhigh',
    minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
    minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
  }

  // Read from the store at session start; true until then.
  let enabled = true
  let announced = false
  const pending = pendingDecisions()
  let appliedTurnId: string | undefined
  let applied: Effort | null = null

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('enabled').catch(() => undefined)
    if (typeof stored === 'boolean') enabled = stored
    await $.command.register({
      name: COMMAND,
      description: 'Jev effort routing for the main loop (on | off | status)',
      argumentHint: 'on|off|status',
      immediate: true,
    })
    if (!announced) {
      announced = true
      if (logDecisions) $.ui.log(`${TAG} ${describeSetup(Boolean(apiKey), url, enabled, policy.maxEffort)}`)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const option = parseToggle(e.args)
    if (option === null) return { text: `Usage: /${COMMAND} [on|off|status]` }
    if (option !== 'status') {
      enabled = option === 'on'
      await $.store.set('enabled', enabled)
      if (!enabled) {
        pending.clear()
        applied = null
        appliedTurnId = undefined
        $.ui.status(undefined)
      }
    }
    const backend = apiKey ? 'TypeSafe Jev' : 'built-in classifier (no TypeSafe key)'
    return {
      text: `Auto effort: ${enabled ? 'on' : 'off'} · ${backend} · ceiling ${policy.maxEffort}`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled || !e.text.trim()) return next(e)

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (apiKey) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(apiKey),
            body: requestBody(e.text, modelId),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`${TAG} typesafe responded ${response.status}`)
        else $.ui.log(`${TAG} classification passed ${timeoutMs}ms; leaving the turn alone`)
      } catch (error) {
        $.ui.log(`${TAG} classification failed: ${String(error)}`)
      }
    } else {
      // No key: the engine's small-model classifier answers the same question,
      // without a confidence, so it can raise effort but never lower it.
      try {
        const label = await $.model.classify(e.text, EFFORT_ORDER)
        if (isEffort(label)) decision = { effort: label, confidence: null, risky: null }
      } catch (error) {
        $.ui.log(`${TAG} built-in classifier failed: ${String(error)}`)
      }
    }

    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`${TAG} jev: ${describeDecision(decision, ms)}`)
    }

    pending.put(decision)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep their own effort; the Agent tool takes none to route.
    // An absent effort means the model takes none; setting one would be refused.
    if (!enabled || e.agentId || e.effort === undefined) return yield* next(e)

    // Every request after the first reuses what the turn settled on, so the
    // effort does not change under the turn's own tool loop.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      return yield* next(applied ? { ...e, effort: applied } : e)
    }

    const decision = pending.take()
    const routing = route(decision, e.effort, policy)
    appliedTurnId = e.turnId
    applied = routing.effort

    const kept = String(e.effort)
    if (logDecisions) {
      $.ui.status(describeStatus(decision, applied, kept))
      $.ui.log(applied ? `${TAG} main loop → effort ${applied}: ${routing.reason}` : `${TAG} main loop: ${routing.reason}`)
    }
    return yield* next(applied ? { ...e, effort: applied } : e)
  })
}
