// P2b (docs/plans/2026-10-06-001-fix-cor-mcp-turns-first-pass-plan.md): cor_explore runs a closed list of steps in one
// call — each as its own tool would — and stops at the first that fails, with the region index and the step to resume from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, baseUrl as base } from './helpers/mcp-site.js';

test('P2b one call: open, read a region, act, see the change, inspect, expect — the replies of each tool, in order', async (t) => {
  const { call } = await connect(t);
  const out = await call('cor_explore', { steps: [
    { open: `${base()}/p3-card-price` },
    { inspect: '.card:nth-child(2) h3' },
    { click: 'label[for=t2]' },
    { expect: '$200 / month' },
    { inspect: '.card:nth-child(1) .card__price:not([hidden])' },
  ] });
  assert.match(out, /^\[1\] open http/m);
  assert.match(out, /^\[2\] inspect \.card:nth-child\(2\) h3\n[\s\S]*cor:[0-9a-f]{6}/m);
  assert.match(out, /^\[3\] click label\[for=t2\]\n[\s\S]*\$200 \/ month/m, 'the act reply lists the changed price');
  assert.match(out, /^\[4\] expect "\$200 \/ month"\n✓ "\$200 \/ month" is shown/m);
  assert.match(out, /^\[5\] inspect [\s\S]*cor:[0-9a-f]{6}/m);
  assert.doesNotMatch(out, /STOPPED/);
});

test('P2b the first step that fails stops the run: why, the region index with refs, and resumeFrom; resuming runs the rest', async (t) => {
  const { call } = await connect(t);
  const steps = [{ open: `${base()}/p3-card-price` }, { click: 'button' }, { expect: 'Team Ultimate' }];
  const stopped = await call('cor_explore', { steps });
  assert.match(stopped, /^\[2\] click button — STOPPED: "button" matches 3 elements/m);
  assert.match(stopped, /Steps 2–3 did not run\. Fix step 2 .* resumeFrom: 2\./);
  assert.match(stopped, /\[ref=e\d+\]/, 'the index lists refs to retry with');
  assert.doesNotMatch(stopped, /^\[3\]/m);
  const resumed = await call('cor_explore', { steps: [...steps.slice(0, 1), { inspect: '.card:nth-child(2) button' }, steps[2]], resumeFrom: 2 });
  assert.match(resumed, /^\[2\] inspect/m);
  assert.match(resumed, /^\[3\] expect "Team Ultimate"\n✓/m);
  assert.doesNotMatch(resumed, /^\[1\]/m, 'step 1 is not run again');
});

test('P2b a step names exactly one verb; text not shown stops the run', async (t) => {
  const { call } = await connect(t);
  assert.match(await call('cor_explore', { steps: [{ open: `${base()}/p3-card-price`, click: 'button' }] }), /names exactly one of .* this one names open and click/);
  assert.match(await call('cor_explore', { steps: [{ open: `${base()}/p3-card-price` }, { expect: 'Team Pro Max' }] }), /STOPPED: "Team Pro Max" is not shown/);
});
