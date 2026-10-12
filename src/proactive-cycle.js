import { randomUUID } from 'node:crypto';
import { buildExperienceMaterial } from './experience-material.js';
import { experienceFailureReason } from './model-client.js';
import { contactIdleAllowed, daytimeEmergenceAllowed, dreamAllowed, recordDream, scheduleDaytimeEmergence, settleState, topDrives } from './engine.js';

const TYPES = ['dream', 'thought', 'daytime'];
const RESULTS = ['declined', 'dry_run', 'sent', 'expired', 'ambiguous'];
function ledger(state) {
  state.proactive ??= { schemaVersion: 1, activeCycleId: null, cycles: {}, experiences: { dream: [], thought: [], daytime: [] }, events: [] };
  return state.proactive;
}
export function appendExperience(state, cycleId, type, value, at) {
  if (!TYPES.includes(type)) throw new Error('invalid_experience_type');
  const data = ledger(state);
  if (!data.cycles[cycleId]) throw new Error('unknown_cycle');
  const id = `${cycleId}:${type}`;
  const existing = data.experiences[type].find(item => item.id === id);
  if (existing) return existing; // Never replace an already persisted experience.
  const item = { ...structuredClone(value), id, cycleId, type, createdAt: at };
  data.experiences[type].push(item);
  return item;
}
export function arbitrate(state, cycleId, agentId, now, ttlMinutes = 120) {
  const data = ledger(state);
  const cycle = data.cycles[cycleId];
  if (!cycle) throw new Error('unknown_cycle');
  if (cycle.arbitrated) return data.events.find(item => item.cycleId === cycleId) ?? null;
  const candidates = TYPES.flatMap(type => data.experiences[type].filter(item => item.cycleId === cycleId && item.wantsExpression === true && item.expressionIntent));
  // A deterministic merge, not another model request and not a final message.
  let event = null;
  if (candidates.length) {
    event = { schemaVersion: 1, agentId, cycleId, eventId: `proactive:${agentId}:${cycleId}`,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
      sources: candidates.map(item => item.type), experienceIds: candidates.map(item => item.id),
      experiences: candidates.map(item => ({ id: item.id, type: item.type, text: item.text, isReality: item.type !== 'dream' ? null : false })),
      expressionIntent: candidates.map(item => item.expressionIntent).join('\n').slice(0, 1200), status: 'pending' };
    data.events.push(event);
  }
  cycle.arbitrated = true;
  cycle.status = 'complete';
  data.activeCycleId = null;
  return event;
}
export function pendingEvent(state, now = new Date()) {
  return structuredClone((state.proactive?.events ?? []).find(event => event.status === 'pending' && Date.parse(event.expiresAt) > now.getTime()) ?? null);
}
export function acknowledgeEvent(state, eventId, result, now = new Date()) {
  if (!RESULTS.includes(result)) throw new Error('invalid_event_result');
  const event = state.proactive?.events?.find(item => item.eventId === eventId);
  if (!event) throw new Error('unknown_event');
  if (event.status !== 'pending') {
    if (event.status !== result) throw new Error('event_result_conflict');
    return event;
  }
  event.status = result;
  event.resolvedAt = now.toISOString();
  return event;
}

// One process owns this runner and the existing StateStore. No distributed lease.
export class ProactiveCycle {
  constructor({ store, config, model, material = buildExperienceMaterial, update, now = () => new Date() }) {
    Object.assign(this, { store, config, model, material, now });
    this.update = update ?? (mutator => store.update(mutator));
    this.running = null;
  }
  run() {
    if (!this.running) this.running = this.execute().finally(() => { this.running = null; });
    return this.running;
  }
  async execute() {
    const now = this.now();
    const config = this.config;
    let cycleId;
    await this.update(state => {
      const data = ledger(state);
      if (data.activeCycleId) { cycleId = data.activeCycleId; return state; }
      const settled = settleState(state, now, config.sleepAfterMinutes, config.settle).state;
      const next = ledger(settled);
      cycleId = randomUUID();
      next.activeCycleId = cycleId;
      next.cycles[cycleId] = { cycleId, startedAt: now.toISOString(), status: 'running', stages: {}, arbitrated: false };
      return settled;
    });
    // Resumed cycles retain their original time, so gates do not move on restart.
    const startedAt = new Date((await this.store.read()).proactive.cycles[cycleId].startedAt);
    for (const type of TYPES) await this.process(cycleId, type, startedAt);
    await this.update(state => { arbitrate(state, cycleId, config.experience.agentId, startedAt, config.experience.ttlMinutes); return state; });
    const state = await this.store.read();
    return { state, cycleId, dreamCreated: state.proactive.experiences.dream.some(item => item.cycleId === cycleId), barkSent: false, daytimeSent: false };
  }
  async process(cycleId, type, now) {
    let state = await this.store.read();
    const cycle = state.proactive.cycles[cycleId];
    if (cycle.stages[type]) {
      if (cycle.stages[type].status === 'started') {
        await this.update(latest => { ledger(latest).cycles[cycleId].stages[type] = { status: 'ambiguous' }; return latest; });
      }
      return; // A crashed HTTP attempt is never silently regenerated.
    }
    const cfg = this.config;
    const exp = cfg.experience;
    const usage = state.proactive.experiences[type];
    let eligible = false;
    if (type === 'dream') eligible = dreamAllowed(state, now, cfg.dreamMinIntervalHours, cfg.dreamMaxPerDay);
    if (type === 'thought') {
      const last = state.proactive.lastThoughtAttemptAt ?? usage.at(-1)?.createdAt;
      eligible = exp.thoughtEnabled && state.consciousness === 'sleeping'
        && contactIdleAllowed(state, now, cfg.heartbeat.proactiveMinIdleHours)
        && topDrives(state, 1).some(item => item.value >= cfg.bark.minDrive)
        && (!last || now.getTime() - Date.parse(last) >= cfg.bark.autonomousMinIntervalHours * 3600000)
        && usage.filter(item => item.createdAt.slice(0, 10) === now.toISOString().slice(0, 10)).length < cfg.bark.maxPerDay;
    }
    if (type === 'daytime' && exp.daytimeEnabled) {
      if (!state.nextDaytimeEmergenceAt) {
        await this.update(latest => scheduleDaytimeEmergence(latest, now, cfg.daytime.minIntervalHours, cfg.daytime.maxIntervalHours));
      } else eligible = daytimeEmergenceAllowed(state, now, cfg.daytime);
    }
    if (!eligible) return this.stage(cycleId, type, 'skipped');
    let material = '';
    let materialChars = 0;
    if (exp.materialEnabled) {
      try {
        const result = await this.material(state, { now, maxChars: exp.model.maxInputChars, cycleId, type });
        material = String(typeof result === 'string' ? result : result.text).slice(0, exp.model.maxInputChars);
        materialChars = typeof result === 'string' ? material.trim().length : Math.min(material.length, result.materialChars);
      } catch { /* No model on missing material. */ }
    }
    const enough = materialChars >= exp.minMaterialChars;
    const canCall = exp.model.enabled && Boolean(exp.model.apiKey) && enough;
    if (type !== 'dream' && !canCall) return this.stage(cycleId, type, 'skipped');
    await this.update(latest => {
      ledger(latest).cycles[cycleId].stages[type] = { status: 'started' };
      if (type === 'thought') latest.proactive.lastThoughtAttemptAt = now.toISOString();
      if (type === 'daytime') latest = scheduleDaytimeEmergence(latest, now, cfg.daytime.minIntervalHours, cfg.daytime.maxIntervalHours);
      return latest;
    });
    let value;
    try {
      value = canCall ? await this.model.generateExperience({ type, state, material, topDrives: topDrives(state) }) : this.model.ruleDream(topDrives(state));
    } catch (error) {
      const failureReason = experienceFailureReason(error);
      if (type !== 'dream') return this.stage(cycleId, type, 'failed', failureReason);
      value = this.model.ruleDream(topDrives(state));
      value.failure = 'model_failed';
      value.failureReason = failureReason;
    }
    // Content and gate bookkeeping are committed together before arbitration.
    await this.update(latest => {
      appendExperience(latest, cycleId, type, value, now.toISOString());
      if (type === 'dream') latest = recordDream(latest, { ...value, id: `${cycleId}:dream`, createdAt: now.toISOString() });
      if (type === 'daytime') {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.daytime.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        latest.daytimeEmergenceUsage ??= {};
        latest.daytimeEmergenceUsage[day] = Number(latest.daytimeEmergenceUsage[day] ?? 0) + 1;
      }
      ledger(latest).cycles[cycleId].stages[type] = { status: 'saved', ...(value.failureReason ? { failureReason: value.failureReason } : {}) };
      return latest;
    });
  }
  stage(cycleId, type, status, failureReason) {
    return this.update(state => { ledger(state).cycles[cycleId].stages[type] = { status, ...(failureReason ? { failureReason } : {}) }; return state; });
  }
}
