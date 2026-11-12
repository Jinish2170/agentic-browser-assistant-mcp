import { z } from 'zod';

const probability = z.number().min(0).max(1);
const description = z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]);
const instructions = description;
export const questionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions,
      criteria: z
        .record(description.nullable())
        .refine(
          (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255,
          'Choice needs 2–255 options',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      instructions,
      criteria: z
        .object({ true: description.optional(), false: description.optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      instructions,
      criteria: z.array(description).min(2).max(10),
    })
    .strict(),
]);
export const questionsSchema = z
  .record(questionSchema)
  .refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64,
    'Use 1–64 questions per evaluation',
  );

function distribution(raw, keys) {
  const values = z.record(probability).parse(raw);
  if (Object.keys(values).length !== keys.length || keys.some((k) => !Object.hasOwn(values, k)))
    throw new Error('JEV_INVALID: Jev returned an invalid option distribution');
  if (Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) > 0.02)
    throw new Error('JEV_INVALID: Jev returned an invalid probability distribution');
  return values;
}

export function validateAnswers(response, questions) {
  const raw = z.record(z.unknown()).parse(response.answers);
  const keys = Object.keys(questions);
  if (Object.keys(raw).length !== keys.length || keys.some((k) => !Object.hasOwn(raw, k)))
    throw new Error('JEV_INVALID: Response question IDs do not match the request');
  return Object.fromEntries(
    keys.map((key) => {
      const question = questions[key];
      const answer = raw[key];
      if (question.type === 'noul')
        return [key, z.object({ type: z.literal('noul'), noul: probability }).parse(answer)];
      if (question.type === 'score') {
        const parsed = z
          .object({
            type: z.literal('score'),
            score: z
              .number()
              .min(0)
              .max(question.criteria.length - 1),
            confidence: probability,
            probabilities: z.unknown(),
            legend: z.record(z.unknown()),
          })
          .parse(answer);
        const levels = question.criteria.map((_, i) => String(i));
        parsed.probabilities = distribution(parsed.probabilities, levels);
        if (
          Object.keys(parsed.legend).length !== levels.length ||
          levels.some((k) => !Object.hasOwn(parsed.legend, k))
        )
          throw new Error('JEV_INVALID: Score levels do not match the request');
        return [key, parsed];
      }
      const parsed = z
        .object({
          type: z.literal('choice'),
          choice: z.string(),
          confidence: probability,
          probabilities: z.unknown(),
        })
        .parse(answer);
      const options = Object.keys(question.criteria);
      if (!options.includes(parsed.choice))
        throw new Error('JEV_INVALID: Jev returned an invalid option distribution');
      parsed.probabilities = distribution(parsed.probabilities, options);
      const sorted = Object.values(parsed.probabilities).sort((a, b) => b - a);
      if (parsed.probabilities[parsed.choice] < sorted[0] - 1e-6)
        throw new Error('JEV_INVALID: Selected choice is not a highest-probability option');
      return [
        key,
        {
          ...parsed,
          topProbability: sorted[0],
          margin: sorted[0] - sorted[1],
          candidateCount: options.length,
        },
      ];
    }),
  );
}
