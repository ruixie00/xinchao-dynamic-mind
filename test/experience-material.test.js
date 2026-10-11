import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExperienceMaterial } from '../src/experience-material.js';

const now = new Date('2026-10-11T04:00:00Z');
test('local material reads fresh notes, flash, ongoing thoughts and separate experiences without mutation', () => {
  const state = {
    handoffNotes: [{ note: 'recent real conversation detail', expiresAt: '2026-10-12', createdAt: '2026-10-11' },
      { note: 'expired private detail', expiresAt: '2026-10-10' }],
    thoughtPool: { flash: [{ text: 'a concrete flash thought' }], obsessions: [{ text: 'an ongoing thought' }] },
    proactive: { experiences: { dream: [{ text: 'a fictional dream', cycleId: 'old', source: 'model' }],
      thought: [{ text: 'previous internal thought', cycleId: 'old', source: 'model' }],
      daytime: [{ text: 'current cycle must be excluded', cycleId: 'current' }] } },
  };
  const before = structuredClone(state);
  const result = buildExperienceMaterial(state, { now, cycleId: 'current' });
  for (const text of ['recent real conversation detail', 'a concrete flash thought', 'an ongoing thought', 'previous internal thought', 'a fictional dream']) assert.ok(result.text.includes(text));
  assert.ok(!result.text.includes('expired private detail'));
  assert.ok(!result.text.includes('current cycle must be excluded'));
  assert.ok(result.text.includes('not external fact'));
  assert.ok(result.materialChars >= 16);
  assert.deepEqual(state, before);
});
test('numeric state, whitespace and expired notes are not material; dreams alone cannot seed a call', () => {
  const state = { drives: { share: 1 }, fatigue: 0.8, consciousness: 'sleeping',
    thoughtPool: { flash: [{ text: 12345 }, { text: '123.45' }, { text: '  ' }], obsessions: [{ intensity: 1 }] },
    handoffNotes: [{ note: 'expired conversation', expiresAt: '2026-10-10' }] };
  assert.deepEqual(buildExperienceMaterial(state, { now }), { text: '', materialChars: 0, sources: [] });
  state.recentDreams = [{ dream: 'a rules dream with many words', source: 'rules' }];
  const result = buildExperienceMaterial(state, { now });
  assert.ok(result.text.includes('rules dream'));
  assert.equal(result.materialChars, 0);
});
test('material budget counts only included text, never labels; duplicates do not inflate sufficiency', () => {
  const state = { thoughtPool: { flash: [{ text: 'x' }], obsessions: [{ text: 'x' }] } };
  const result = buildExperienceMaterial(state);
  assert.equal(result.materialChars, 1);
  assert.equal(result.sources.length, 1);
  const clipped = buildExperienceMaterial({ thoughtPool: { flash: [{ text: 'a'.repeat(500) }] } }, { maxChars: 100 });
  assert.equal(clipped.text.length, 100);
  assert.equal(clipped.materialChars, 92);
});
