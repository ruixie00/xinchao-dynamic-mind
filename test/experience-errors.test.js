import test from 'node:test';
import assert from 'node:assert/strict';
import { ExperienceModel, experienceFailureReason } from '../src/model-client.js';

test('diagnostics distinguish request and response failures without exposing private content or retrying', async () => {
  const cfg = { enabled: true, apiKey: 'private-key', name: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', timeoutMs: 1000, maxOutputTokens: 650, maxInputChars: 3000 };
  const input = { type: 'dream', state: {}, material: 'private-material', topDrives: [] };
  const cases = [
    [async () => { throw new DOMException('private timeout', 'TimeoutError'); }, 'experience_timeout'],
    [async () => { throw new DOMException('private abort', 'AbortError'); }, 'experience_aborted'],
    [async () => { throw new TypeError('private-key private-material'); }, 'experience_transport_error'],
    [async () => ({ ok: false, status: 429 }), 'experience_http_429'],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError('private response'); } }), 'experience_response_invalid_json'],
    [async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'private invalid JSON' } }] }) }), 'experience_content_invalid_json'],
    [async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'null' } }] }) }), 'invalid_experience_output'],
    [async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: 'private text', wantsExpression: false, expressionIntent: '' }) } }] }) }), 'invalid_dream_output'],
  ];
  for (const [request, expected] of cases) {
    let attempts = 0;
    await assert.rejects(new ExperienceModel(cfg, (...args) => { attempts++; return request(...args); }).generateExperience(input), error => {
      assert.equal(experienceFailureReason(error), expected); return true;
    });
    assert.equal(attempts, 1);
  }
  assert.equal(experienceFailureReason(new Error('private-key private-material')), 'experience_unknown_error');
  assert.equal(experienceFailureReason(new TypeError('private programming error')), 'experience_unknown_error');
  assert.equal(experienceFailureReason(new Error('experience_http_429 private-key')), 'experience_unknown_error');
});
