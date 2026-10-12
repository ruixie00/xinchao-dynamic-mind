import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, settleState } from '../src/engine.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { ExperienceModel } from '../src/model-client.js';
import { StateStore } from '../src/state-store.js';
import { ProactiveCycle, acknowledgeEvent } from '../src/proactive-cycle.js';

const now = new Date('2026-10-11T04:00:00Z');
const ago = new Date(now.getTime() - 24 * 3600000);
function configuration() {
  const config = loadConfig();
  config.shadowMode = true;
  config.ombre.readEnabled = false;
  config.experience.enabled = true;
  config.experience.materialEnabled = true;
  config.experience.thoughtEnabled = true;
  config.experience.daytimeEnabled = true;
  config.experience.model.enabled = true;
  config.experience.model.apiKey = 'fake-only';
  return config;
}
async function fixture(t, seed = newState(ago)) {
  const dir = await mkdtemp(join(tmpdir(), 'experience-cycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, 'state.json'), () => seed);
  return store;
}
function output(type, wantsExpression = true) {
  return { text: `internal ${type}`, dream: 'dream', residue: 'residue', awareness: 'awareness',
    source: 'model', wantsExpression, expressionIntent: wantsExpression ? `share ${type}` : '' };
}

test('failed experiences persist safe diagnostics and preserve rules dream without retries or events', async t => {
  const config = configuration();
  const seed = newState(ago);
  seed.lastHeartbeatAt = ago.toISOString(); seed.drives.share = 1;
  seed.nextDaytimeEmergenceAt = ago.toISOString();
  const store = await fixture(t, seed);
  const calls = [];
  const model = { generateExperience: async ({ type }) => {
    calls.push(type);
    throw type === 'dream' ? new Error('invalid_dream_output') : new Error('private secret and material');
  }, ruleDream: drives => new ExperienceModel(config.experience.model).ruleDream(drives) };
  const result = await new ProactiveCycle({ store, config, model, material: async () => 'enough private material', now: () => now }).run();
  assert.deepEqual(calls, ['dream', 'thought', 'daytime']);
  const dream = result.state.proactive.experiences.dream[0];
  assert.equal(dream.source, 'rules'); assert.equal(dream.failure, 'model_failed');
  assert.equal(dream.failureReason, 'invalid_dream_output');
  for (const type of ['thought', 'daytime']) {
    assert.equal(result.state.proactive.experiences[type].length, 0);
    assert.deepEqual(result.state.proactive.cycles[result.cycleId].stages[type], { status: 'failed', failureReason: 'experience_unknown_error' });
  }
  assert.equal(result.state.proactive.events.length, 0);
  assert.equal(result.state.proactive.activeCycleId, null);
  const reloaded = await new StateStore(store.path, () => seed).read();
  assert.equal(reloaded.proactive.experiences.dream[0].failureReason, 'invalid_dream_output');
  assert.ok(!JSON.stringify(reloaded.proactive).includes('private secret'));
});

test('original rule-only awake cycle has zero model calls and identical state evolution', async t => {
  const config = configuration();
  config.experience.daytimeEnabled = false;
  const seed = newState(now);
  const store = await fixture(t, seed);
  const expected = settleState(seed, now, config.sleepAfterMinutes, config.settle).state;
  const runner = new ProactiveCycle({ store, config, model: { generateExperience() { assert.fail('no model'); } }, now: () => now });
  const result = await runner.run();
  const { proactive, ...rest } = result.state;
  assert.deepEqual(rest, expected);
  assert.equal(proactive.events.length, 0);
  assert.equal(config.settleIntervalMinutes, 15);
});

test('shadow=true uses fresh local text without Ombre; numeric-only, expired and short material make zero requests', async t => {
  for (const mode of ['fresh', 'numeric', 'expired', 'short', 'dream-only']) {
    const config = configuration();
    config.experience.daytimeEnabled = false;
    const seed = newState(ago);
    seed.lastHeartbeatAt = ago.toISOString(); seed.drives.share = 1;
    if (mode === 'fresh' || mode === 'expired') seed.handoffNotes = [{ note: 'specific conversation detail for internal experience',
      expiresAt: mode === 'fresh' ? '2026-10-12T00:00:00Z' : ago.toISOString(), createdAt: ago.toISOString() }];
    if (mode === 'short') seed.thoughtPool.flash = [{ text: 'x', intensity: 0.1, age: 0 }];
    if (mode === 'dream-only') seed.recentDreams = [{ dream: 'a prior rules dream is not fresh external memory', source: 'rules', createdAt: ago.toISOString() }];
    const store = await fixture(t, seed);
    let calls = 0;
    const model = { generateExperience: async ({ type, material }) => {
      calls++; assert.ok(material.includes('specific conversation detail')); return output(type);
    }, ruleDream: drives => new ExperienceModel(config.experience.model).ruleDream(drives) };
    const result = await new ProactiveCycle({ store, config, model, now: () => now }).run();
    assert.equal(calls, mode === 'fresh' ? 2 : 0, mode);
    assert.equal(result.state.proactive.experiences.dream.length, 1);
  }
});

test('dream, thought and daytime persist separately before one event; no-send experience survives', async t => {
  const config = configuration();
  const seed = newState(ago);
  seed.lastHeartbeatAt = ago.toISOString();
  seed.drives.share = 0.9;
  seed.nextDaytimeEmergenceAt = ago.toISOString();
  const store = await fixture(t, seed);
  const calls = [];
  const model = { generateExperience: async ({ type }) => { calls.push(type); return output(type, type !== 'thought'); } };
  const runner = new ProactiveCycle({ store, config, model, material: async () => 'specific memory material with enough detail', now: () => now });
  const first = await runner.run();
  assert.deepEqual(calls, ['dream', 'thought', 'daytime']);
  for (const type of calls) assert.equal(first.state.proactive.experiences[type].length, 1);
  assert.equal(first.state.proactive.events.length, 1);
  assert.deepEqual(first.state.proactive.events[0].sources, ['dream', 'daytime']);
  const saved = structuredClone(first.state.proactive.experiences);
  await store.update(state => { acknowledgeEvent(state, state.proactive.events[0].eventId, 'sent', now); return state; });
  await new ProactiveCycle({ store, config, model, material: async () => 'enough material', now: () => new Date(now.getTime() + 15 * 60000) }).run();
  assert.equal(calls.length, 3);
  assert.deepEqual((await store.read()).proactive.experiences, saved);
});

test('no material, disabled material and disabled model do not call; rules dream remains durable', async t => {
  for (const mode of ['empty', 'material-disabled', 'disabled']) {
    const config = configuration();
    if (mode === 'material-disabled') config.experience.materialEnabled = false;
    if (mode === 'disabled') config.experience.model.enabled = false;
    const seed = newState(ago); seed.lastHeartbeatAt = ago.toISOString(); seed.nextDaytimeEmergenceAt = ago.toISOString(); seed.drives.share = 0.9;
    const store = await fixture(t, seed);
    const model = { generateExperience() { assert.fail('must be zero'); }, ruleDream: drives => new ExperienceModel(config.experience.model).ruleDream(drives) };
    const result = await new ProactiveCycle({ store, config, model, material: async () => mode === 'empty' ? '' : 'sufficient material for a real memory', now: () => now }).run();
    assert.equal(result.state.proactive.experiences.dream[0].source, 'rules');
    assert.equal(result.state.proactive.events.length, 0);
  }
});

test('restart resumes saved stages, fences unknown HTTP result, retains cycle ID and settles once', async t => {
  const config = configuration();
  const seed = newState(ago); seed.lastHeartbeatAt = ago.toISOString(); seed.drives.share = 0.9;
  const store = await fixture(t, seed);
  let calls = 0, crash = true;
  const model = { generateExperience: async ({ type }) => { calls++; return output(type); } };
  const runner = new ProactiveCycle({ store, config, model, material: async () => 'sufficient memory material', now: () => now,
    update: mutator => store.update(state => {
      const next = mutator(state);
      if (crash && next.proactive?.experiences.dream.length) { crash = false; throw new Error('simulated crash before result persisted'); }
      return next;
    }) });
  await assert.rejects(runner.run(), /simulated crash/);
  const crashed = await store.read();
  const id = crashed.proactive.activeCycleId;
  const resumed = await new ProactiveCycle({ store, config, model, material: async () => '', now: () => new Date(now.getTime() + 60000) }).run();
  assert.equal(resumed.cycleId, id);
  assert.equal(calls, 1);
  assert.equal(resumed.state.lastSettledAt, crashed.lastSettledAt);
  assert.equal(resumed.state.proactive.cycles[id].stages.dream.status, 'ambiguous');
});

test('saved results survive a crash before arbitration without another model call', async t => {
  const config = configuration(); config.experience.thoughtEnabled = false; config.experience.daytimeEnabled = false;
  const store = await fixture(t);
  let calls = 0, crash = true;
  const model = { generateExperience: async ({ type }) => { calls++; return output(type); } };
  const runner = new ProactiveCycle({ store, config, model, material: async () => 'sufficient memory material', now: () => now,
    update: mutator => store.update(state => { const next = mutator(state); if (crash && next.proactive?.cycles[Object.keys(next.proactive.cycles)[0]]?.arbitrated) { crash = false; throw new Error('crash before arbitration commit'); } return next; }) });
  await assert.rejects(runner.run(), /crash before arbitration/);
  const saved = (await store.read()).proactive.experiences;
  const result = await new ProactiveCycle({ store, config, model, now: () => now }).run();
  assert.equal(calls, 1); assert.deepEqual(result.state.proactive.experiences, saved); assert.equal(result.state.proactive.events.length, 1);
});

test('model route rejects Opus and legacy endpoint; invalid output and outage have one attempt, no fallback', async () => {
  const cfg = configuration().experience.model;
  let calls = 0;
  const request = async (url, init) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body); assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.thinking.type, 'disabled'); assert.equal(body.tools, undefined);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output('thought', false)) } }] }) };
  };
  const input = { type: 'thought', state: {}, material: 'material', topDrives: [] };
  assert.equal((await new ExperienceModel(cfg, request).generateExperience(input)).wantsExpression, false);
  for (const name of ['anthropic/claude-opus-4.6', 'deepseek-reasoner']) await assert.rejects(new ExperienceModel({ ...cfg, name }, request).generateExperience(input), /not_allowed/);
  await assert.rejects(new ExperienceModel({ ...cfg, baseUrl: 'https://openrouter.ai/api/v1' }, request).generateExperience(input), /not_allowed/);
  assert.equal(calls, 1);
  for (const bad of ['{"text":"private","wantsExpression":"false"}', 'not JSON']) {
    await assert.rejects(new ExperienceModel(cfg, async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: bad } }] }) }; }).generateExperience(input));
  }
  await assert.rejects(new ExperienceModel(cfg, async () => { calls++; throw new Error('timeout'); }).generateExperience(input), /timeout/);
  assert.equal(calls, 4);
});

test('experience mode cannot accidentally enable legacy Bark, model or bridge', () => {
  const cfg = configuration(); cfg.ombre.readEnabled = false;
  for (const key of ['bark', 'model', 'bridge']) assert.throws(() => validateConfig({ ...cfg, [key]: { ...cfg[key], enabled: true } }), /remain false/);
});

test('HTTP failure preserves a rules dream and records failed internal attempts without an outward event', async t => {
  const config = configuration(); const seed = newState(ago);
  seed.lastHeartbeatAt = ago.toISOString();
  seed.drives.share = 1; seed.nextDaytimeEmergenceAt = ago.toISOString();
  const store = await fixture(t, seed); let calls = 0;
  const model = new ExperienceModel(config.experience.model, async () => { calls++; return { ok: false, status: 503 }; });
  const result = await new ProactiveCycle({ store, config, model, material: async () => 'sufficient memory material', now: () => now }).run();
  assert.equal(calls, 3);
  assert.equal(result.state.proactive.experiences.dream.length, 1);
  assert.equal(result.state.proactive.experiences.dream[0].failure, 'model_failed');
  assert.equal(result.state.proactive.cycles[result.cycleId].stages.thought.status, 'failed');
  assert.equal(result.state.proactive.cycles[result.cycleId].stages.daytime.status, 'failed');
  assert.equal(result.state.proactive.events.length, 0);
});

test('bounded request timeout aborts the injected transport without another request', async () => {
  const cfg = { ...configuration().experience.model, timeoutMs: 10 }; let calls = 0;
  const request = async (_, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test transport did not abort')), 250);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  await assert.rejects(new ExperienceModel(cfg, request).generateExperience({ type: 'thought', state: {}, material: 'material', topDrives: [] }), { name: 'TimeoutError' });
  assert.equal(calls, 1);
});
