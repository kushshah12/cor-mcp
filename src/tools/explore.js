// P2b: cor_explore — a closed, ordered list of steps in one call, so the discovery an agent spends one turn per step on
// (open, act, read, inspect) is one turn. Each step runs the tool it names, with that tool's own checks and reply; there
// are no conditionals, loops or code. The run stops at the first step that fails — an element that is not exactly one,
// an act that cannot land, text that is not shown — and returns what ran, why it stopped, the page's region index (refs
// to retry with) and the step to resume from.
import { z } from 'zod';

const REF = /^e\d+$/;
const MAX_STEPS = 20;

const step = z.object({
  open: z.string().url().optional().describe('Open this URL (cor_open).'),
  click: z.string().optional().describe('Click a ref or a CSS selector matching one element (cor_click).'),
  fill: z.string().optional().describe('Fill a ref or a CSS selector (cor_fill) with value.'),
  value: z.string().optional().describe('The text for fill.'),
  press: z.string().optional().describe('Press a key (cor_press), on target when given.'),
  target: z.string().optional().describe('For press: the ref or selector to focus first.'),
  inspect: z.union([z.string(), z.array(z.string()).min(1).max(30)]).optional().describe('A ref or selector, or several (cor_inspect targets).'),
  within: z.string().optional().describe('A region\'s text, controls and entries (cor_snapshot within).'),
  expect: z.string().optional().describe('Text that must be shown on the page now, exactly.'),
}).strict();

const VERBS = ['open', 'click', 'fill', 'press', 'inspect', 'within', 'expect'];
const pick = (target) => (REF.test(target.trim()) ? { ref: target.trim() } : { target });

/** The tool call a step stands for, or why the step is not one COR runs. */
function callFor(s) {
  const verbs = VERBS.filter((v) => s[v] !== undefined);
  if (verbs.length !== 1) return { error: `a step names exactly one of ${VERBS.join(', ')} — this one names ${verbs.length ? verbs.join(' and ') : 'none'}` };
  const [verb] = verbs;
  if (verb === 'fill' && s.value === undefined) return { error: 'fill needs value' };
  switch (verb) {
    case 'open': return { tool: 'cor_open', args: { url: s.open }, label: `open ${s.open}` };
    case 'click': return { tool: 'cor_click', args: pick(s.click), label: `click ${s.click}` };
    case 'fill': return { tool: 'cor_fill', args: { ...pick(s.fill), value: s.value }, label: `fill ${s.fill}` };
    case 'press': return { tool: 'cor_press', args: { key: s.press, ...(s.target ? pick(s.target) : {}) }, label: `press ${s.press}${s.target ? ` on ${s.target}` : ''}` };
    case 'inspect': return Array.isArray(s.inspect)
      ? { tool: 'cor_inspect', args: { targets: s.inspect }, label: `inspect ${s.inspect.join(', ')}` }
      : { tool: 'cor_inspect', args: REF.test(s.inspect.trim()) ? { ref: s.inspect.trim() } : { selector: s.inspect }, label: `inspect ${s.inspect}` };
    case 'within': return { tool: 'cor_snapshot', args: { within: s.within }, label: `within ${s.within}` };
    default: return { expect: s.expect, label: `expect "${s.expect}"` };
  }
}

const textOf = (result) => (result?.content ?? []).map((c) => c.text ?? '').join('\n');

/** @param {Array<{ name: string, handler: Function }>} tools the server's other tools, run by name */
export function exploreTools(session, tools) {
  const byName = new Map(tools.map((t) => [t.name, t.handler]));
  return [{
    name: 'cor_explore',
    config: {
      title: 'Run several steps in one call',
      description:
        'Discovery in one call: a list of steps, run in order — { open: url }, { click: ref|selector }, { fill: ref|selector, value }, ' +
        '{ press: key, target? }, { inspect: ref|selector|[…] }, { within: region }, { expect: "exact text shown" }. Each step replies as its own ' +
        'tool would; refs from one step work in the next until a step opens a new page. No conditions or loops. It stops at the first step ' +
        'that fails (an element that is not exactly one, text not shown) and returns what ran, the page\'s region index with refs, and the ' +
        'step to resume from (resumeFrom). Put static elements first and the step that navigates away last.',
      inputSchema: {
        steps: z.array(step).min(1).max(MAX_STEPS).describe('Steps, in order.'),
        resumeFrom: z.number().int().min(1).optional().describe('Skip to this step number (1-based) — from a previous stopped run.'),
      },
    },
    handler: async ({ steps, resumeFrom = 1 }) => {
      const out = [];
      for (let i = resumeFrom - 1; i < steps.length; i++) {
        const n = i + 1;
        const call = callFor(steps[i]);
        let failure = call.error ?? null;
        let reply = '';
        if (!failure) {
          try {
            if (call.expect !== undefined) {
              if (!session.isOpen) throw new Error('No page is open — open one first.');
              const page = await session.getPage();
              const shown = await page.getByText(call.expect, { exact: true }).filter({ visible: true }).count();
              if (!shown) throw new Error(`"${call.expect}" is not shown on ${page.url()} (exact text).`);
              reply = `✓ "${call.expect}" is shown${shown > 1 ? ` (${shown} places)` : ''}.`;
            } else {
              const result = await byName.get(call.tool)(call.args);
              reply = textOf(result);
              if (result?.isError) failure = reply;
            }
          } catch (error) {
            failure = error.message;
          }
        }
        if (failure) {
          out.push(`[${n}] ${call.label ?? 'step'} — STOPPED: ${failure}`);
          const index = session.isOpen ? textOf(await byName.get('cor_snapshot')({}).catch(() => null)) : '';
          out.push('', `Steps ${n}–${steps.length} did not run. Fix step ${n} (a ref from the index below, or a narrower selector) and call cor_explore again with resumeFrom: ${n}.`);
          if (index) out.push('', index);
          return { content: [{ type: 'text', text: out.join('\n') }], isError: true };
        }
        out.push(`[${n}] ${call.label}`, reply, '');
      }
      return { content: [{ type: 'text', text: out.join('\n').trimEnd() }] };
    },
  }];
}
