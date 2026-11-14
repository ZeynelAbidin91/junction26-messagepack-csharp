// Output shapes for the two reviewing-agent calls, as zod schemas. They are sent to the API as JSON
// schemas (structured outputs), and every response is validated again here before it is used.

import { z } from 'zod';

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  referencedSource: z.string().nullable(),
  projectSource: z.string(),
  makeExpression: z.string(),
  describeExpression: z.string(),
  why: z.string(),
});

export const Plan = z.object({
  understanding: z.string(),
  scenarios: z.array(Scenario),
});

const Status = z.enum(['changed', 'affected', 'same']);
const Evidence = z.enum(['observed', 'static', 'stated', 'none']);

export const Analysis = z.object({
  summary: z.string(),
  nodes: z.array(z.object({ id: z.string(), label: z.string(), sub: z.string(), status: Status })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().nullable(), changed: z.boolean() })),
  attention: z.array(z.object({ level: z.enum(['WARNING', 'CAUTION', 'IMPORTANT', 'TIP', 'NOTE']), title: z.string(), detail: z.string() })),
  traces: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      story: z.string(),
      where: z.array(z.object({ handoff: z.string(), text: z.string() })),
    }),
  ),
  units: z.array(
    z.object({
      name: z.string(),
      status: Status,
      where: z.string().nullable(),
      receives: z.string(),
      emits: z.string(),
      change: z.string(),
      examples: z.array(z.object({ input: z.string(), before: z.string(), after: z.string(), evidence: Evidence, ref: z.string().nullable() })),
    }),
  ),
  claims: z.array(
    z.object({
      claim: z.string(),
      source: z.string(),
      verdict: z.enum(['verified', 'partly', 'not-verified', 'contradicted']),
      evidence: z.string(),
    }),
  ),
  limits: z.array(z.string()),
});

/** JSON schema for structured outputs: every object closed, every property required. */
export function toApiSchema(schema) {
  const js = z.toJSONSchema(schema);
  delete js.$schema;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(js);
  return js;
}
