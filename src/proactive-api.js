import { acknowledgeEvent, pendingEvent } from './proactive-cycle.js';

// Called only behind the existing SERVICE_TOKEN authorization in server.js.
export async function proactiveResponse({ method, pathname, payload, store, enabled, now = new Date() }) {
  if (!['/v1/proactive/pending', '/v1/proactive/ack'].includes(pathname)) return null;
  if (!enabled) return { status: 404, body: { error: 'proactive handoff disabled' } };
  if (method === 'GET' && pathname === '/v1/proactive/pending') {
    return { status: 200, body: { schemaVersion: 1, event: pendingEvent(await store.read(), now) } };
  }
  if (method === 'POST' && pathname === '/v1/proactive/ack') {
    if (!payload || Object.keys(payload).some(key => !['eventId', 'result'].includes(key))
      || typeof payload.eventId !== 'string' || payload.eventId.length > 120 || typeof payload.result !== 'string') {
      return { status: 400, body: { error: 'invalid proactive acknowledgement' } };
    }
    let event;
    try {
      await store.update(state => { event = acknowledgeEvent(state, payload.eventId, payload.result, now); return state; });
      return { status: 200, body: { eventId: event.eventId, status: event.status } };
    } catch (error) {
      return { status: 409, body: { error: error.message } };
    }
  }
  return { status: 405, body: { error: 'method not allowed' } };
}
