import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import { appendExperience, arbitrate, acknowledgeEvent, pendingEvent } from '../src/proactive-cycle.js';

test('all experience types survive selection, decline, dry-run and reload without replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'experience-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = new StateStore(path, () => ({}));
  const now = new Date('2026-10-11T04:00:00Z');
  await store.update(state => {
    // An existing cycle has already been persisted before generation.
    state.proactive = { cycles: {}, experiences: { dream: [], thought: [], daytime: [] }, events: [] };
    for (const cycleId of ['a', 'b']) {
      state.proactive.cycles[cycleId] = {};
      for (const type of ['dream', 'thought', 'daytime']) {
        appendExperience(state, cycleId, type, { text: `${cycleId}-${type}`, wantsExpression: type !== 'thought', expressionIntent: type }, now.toISOString());
      }
      appendExperience(state, cycleId, 'thought', { text: 'must not replace original' }, now.toISOString());
      arbitrate(state, cycleId, 'ethan', now);
      arbitrate(state, cycleId, 'ethan', now);
    }
    return state;
  });
  const before = structuredClone((await store.read()).proactive.experiences);
  await store.update(state => { acknowledgeEvent(state, 'proactive:ethan:a', 'declined', now); acknowledgeEvent(state, 'proactive:ethan:b', 'dry_run', now); return state; });
  const reloaded = await new StateStore(path, () => assert.fail('existing state')).read();
  assert.deepEqual(reloaded.proactive.experiences, before);
  assert.equal(reloaded.proactive.events.length, 2);
  assert.equal(reloaded.proactive.events[0].experienceIds.length, 2);
  assert.equal(pendingEvent(reloaded, now), null);
  assert.throws(() => acknowledgeEvent(reloaded, 'proactive:ethan:a', 'sent'), /conflict/);
  acknowledgeEvent(reloaded, 'proactive:ethan:a', 'declined');
});

test('no desire creates no external event but keeps the internal experience', () => {
  const state = { proactive: { cycles: { c: {} }, experiences: { dream: [], thought: [], daytime: [] }, events: [] } };
  appendExperience(state, 'c', 'daytime', { text: 'private reflection', wantsExpression: false }, new Date().toISOString());
  assert.equal(arbitrate(state, 'c', 'ethan', new Date()), null);
  assert.equal(state.proactive.experiences.daytime.length, 1);
});
