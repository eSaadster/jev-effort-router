/**
 * jev-effort-router — pure decision logic.
 *
 * No `$` and no I/O here: this module builds the request TypeSafe's decision
 * API takes, reads its answer, and turns that answer into a reasoning level.
 * The hooks module does every call on `$` at its own call site.
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   `{ model, state, questions }`; a yes/no question is a `noul` and every
 *   answer carries its own `confidence`.
 *
 * Adapted from jev-model-router (claude-code-templates, MIT): the tier
 * question and all model routing are gone, and effort is asked as one choice
 * with a description per level instead of a 0..3 score.
 */

/** The reasoning levels the router may ask for, cheapest first. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

export type Effort = (typeof EFFORT_ORDER)[number]

/**
 * How each level is described to the decision model. Effort buys verification,
 * edge-case testing and independent judgement, not a better approach, so the
 * levels are told apart by how much of that the task needs and how closely the
 * user stays in the loop. After "Spending your effort" (Thariq, 25 Sep 2026).
 */
const EFFORT_CRITERIA: Record<Effort, string> = {
  low: 'Quick and in the loop: questions, explanations, brainstorming, sketching or prototyping an idea to iterate on, easy or obvious changes, formatting, reading or summarising files, running a command, or a small follow-up tweak to work just done.',
  medium:
    'Regular software engineering: implementing a feature or change, especially from a clear spec, refactoring, writing tests, fixing a bug whose cause is already known, reviewing a small diff.',
  high: 'Verification matters or edge cases are likely: fixing a bug in an existing (brownfield) codebase, reproducing a failure before fixing it, testing and verifying work already built, code review, performance work, data analysis whose result depends on method choices.',
  xhigh:
    'Hard problems to solve autonomously, or many hidden edge cases: a failure whose cause is unknown, security review or finding vulnerabilities, sanitisers and parsers, concurrency or storage engines, data migrations, hardware, end-to-end building and verifying an app without the user in the loop.',
}

const EFFORT_INSTRUCTIONS =
  "Select the least reasoning effort likely to solve the user's request reliably. Higher effort mainly buys more verification, edge-case testing and independent judgement; it does not fix a wrong approach. Judge the task, not the length of the prompt. Favour less effort when the user is iterating, sketching, asking or wants to stay in the loop, and when a detailed spec already settles the choices. Favour more effort when correctness is hard to check, edge cases are hidden, the codebase is existing and unfamiliar, or the user asks for the work done end to end without them."

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai'

export const DEFAULT_MODEL = 'jev-latest'

export interface Decision {
  effort: Effort
  /** Confidence in the effort, or null when the classifier reported none. */
  confidence: number | null
  /** P(true) that carrying the task out would itself be costly or final. */
  risky: number | null
}

/** The full endpoint the request posts to. */
export function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/systemone`
}

/** The `questions` map. */
export function questions(): Record<string, unknown> {
  return {
    effort: {
      type: 'choice',
      instructions: EFFORT_INSTRUCTIONS,
      criteria: EFFORT_CRITERIA,
    },
    risky: {
      type: 'noul',
      // Asked about the act, not the subject: code that is about money is not
      // the same as moving money.
      instructions:
        'Carrying out this task would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.',
    },
  }
}

/**
 * Bounds how much of the prompt leaves the machine: the head says what is
 * asked, the tail usually holds the actual request after pasted material.
 */
export function shorten(prompt: string, limit = 6000): string {
  const text = prompt.trim()
  if (text.length <= limit) return text
  const head = Math.floor(limit / 6)
  return `${text.slice(0, head)}\n…\n${text.slice(-(limit - head))}`
}

export function requestBody(prompt: string, model: string): string {
  return JSON.stringify({ model, state: { prompt: shorten(prompt) }, questions: questions() })
}

export function requestHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_ORDER as readonly string[]).includes(value)
}

/** Reads TypeSafe's answer, or null when it holds no usable effort. */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> } | null)?.answers
  const effortAnswer = answers?.effort
  if (!effortAnswer || !isEffort(effortAnswer.choice)) return null

  const riskyAnswer = answers.risky
  return {
    effort: effortAnswer.choice,
    confidence: typeof effortAnswer.confidence === 'number' ? effortAnswer.confidence : null,
    risky: typeof riskyAnswer?.noul === 'number' ? riskyAnswer.noul : null,
  }
}

/**
 * Where a reasoning level sits on the ladder, or null when its place cannot
 * be known. `max` ranks above every rung without joining EFFORT_ORDER, which
 * is also the set of values this router is allowed to ask for.
 */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== 'string') return null
  if (effort === 'max') return EFFORT_ORDER.length
  const index = EFFORT_ORDER.indexOf(effort as Effort)
  return index === -1 ? null : index
}

export interface PolicyConfig {
  /** The highest level the router will ask for. */
  maxEffort: Effort
  /** How sure the decision must be to spend more. Wrong costs money: low bar. */
  minUpgradeConfidence: number
  /** How sure it must be to spend less. Wrong starves a task: high bar. */
  minDowngradeConfidence: number
}

export interface Routing {
  /** The reasoning level to ask for, or null to leave the turn as it is. */
  effort: Effort | null
  /** Why, for the log line. */
  reason: string
}

/**
 * Turns a decision into a reasoning level, or null to leave the turn alone.
 * Both directions are allowed; they clear different confidence bars because
 * the two mistakes do not cost the same.
 */
export function route(
  decision: Decision | null,
  current: string | number | undefined,
  config: PolicyConfig,
): Routing {
  if (!decision) return { effort: null, reason: 'no decision' }
  // A numeric effort is the caller's own scale, not this ladder; leave it.
  if (typeof current === 'number') return { effort: null, reason: `kept numeric effort ${current}` }

  const ceiling = EFFORT_ORDER.indexOf(config.maxEffort)
  const currentRank = effortRank(current)
  let wanted = Math.min(EFFORT_ORDER.indexOf(decision.effort), ceiling)
  let forced = false

  // Carrying out something final gets real reasoning whatever the cheaper
  // answer said, and never less than it already had.
  if (decision.risky !== null && decision.risky > 0.7) {
    wanted = Math.max(wanted, Math.min(EFFORT_ORDER.indexOf('high'), ceiling))
    if (currentRank !== null) wanted = Math.max(wanted, Math.min(currentRank, ceiling))
    forced = true
  }

  const said =
    decision.confidence === null ? 'confidence n/d' : `confidence ${decision.confidence.toFixed(2)}`
  const target = EFFORT_ORDER[wanted] as Effort

  if (currentRank !== null && wanted === currentRank) {
    return { effort: null, reason: `kept ${current} (${said})` }
  }

  const isDowngrade = currentRank !== null && wanted < currentRank
  const bar = isDowngrade ? config.minDowngradeConfidence : config.minUpgradeConfidence
  // No reported confidence clears the upgrade bar but never the downgrade
  // one: spending less on an unmeasured hunch is the bad trade.
  const passes =
    forced || (decision.confidence === null ? !isDowngrade : decision.confidence >= bar)

  if (!passes) {
    return { effort: null, reason: `kept ${current ?? 'default'}, wanted ${target} (${said})` }
  }
  return { effort: target, reason: forced ? `${target}, forced by risk` : `${target} (${said})` }
}

/**
 * Holds a prompt's classification until the turn that reads that prompt
 * starts. When more than one prompt is waiting, which one a turn reads is
 * unknowable, so `take` reports none rather than a decision that may not fit.
 */
export function pendingDecisions(): {
  put(decision: Decision | null): void
  take(): Decision | null
  clear(): void
} {
  let held: Decision | null = null
  let waiting = 0

  return {
    put(decision) {
      waiting += 1
      held = waiting === 1 ? decision : null
    },
    take() {
      const decision = waiting === 1 ? held : null
      held = null
      waiting = 0
      return decision
    },
    clear() {
      held = null
      waiting = 0
    },
  }
}

function reported(value: number | null): string {
  return value === null ? 'n/d' : value.toFixed(2)
}

/** The one-time line that says the router loaded and what answers it. */
export function describeSetup(hasKey: boolean, url: string, enabled: boolean, maxEffort: Effort): string {
  const backend = hasKey ? `typesafe (${url})` : 'the built-in classifier, no key set'
  return `ready on ${backend}; ceiling ${maxEffort}; ${enabled ? 'on' : 'off (/auto-effort on)'}`
}

/** What the classifier answered, before the policy touches it. */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)}ms`
  if (!decision) return `no answer${took}`
  const parts = [`effort ${decision.effort} (${reported(decision.confidence)})`]
  if (decision.risky !== null) parts.push(`risky ${reported(decision.risky)}`)
  return parts.join(' · ') + took
}

/** The persistent status line: the last thing the router did. */
export function describeStatus(decision: Decision | null, applied: Effort | null, kept: string): string {
  if (!decision) return `effort · ${kept} · no answer`
  const asked = `${decision.effort} ${reported(decision.confidence)}`
  return applied ? `effort · ${asked} → ${applied}` : `effort · ${asked} · kept ${kept}`
}

/** Parses `/auto-effort`'s argument. */
export function parseToggle(args: string): 'on' | 'off' | 'status' | null {
  const option = args.trim().toLowerCase()
  if (option === 'on' || option === 'off') return option
  if (option === '' || option === 'status') return 'status'
  return null
}
