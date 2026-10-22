import type { Interaction } from '../../protocol/src/index.ts'

/** Keep selected offered options separate from user-entered text for DSH validation. */
export function questionAnswer(questions: NonNullable<Interaction['questions']>, values: Record<string, string[]>): { answers: Record<string, string[]>; custom: Record<string, string> } {
  const answers: Record<string, string[]> = {}
  const custom: Record<string, string> = {}
  for (const question of questions) {
    const offered = new Set(question.options ?? [])
    const input = values[question.id] ?? []
    answers[question.id] = input.filter(value => offered.has(value))
    const text = input.filter(value => !offered.has(value)).join('\n').trim()
    if (text) custom[question.id] = text
  }
  return { answers, custom }
}
