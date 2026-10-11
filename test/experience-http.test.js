import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newState } from '../src/engine.js';

test('actual shadow service cycle uses only the cheap substitute and never enters legacy clients', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'experience-http-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const at = new Date(Date.now() - 24 * 3600000);
  const state = newState(at);
  state.lastHeartbeatAt = at.toISOString(); state.drives.share = 1;
  state.handoffNotes = [{ note: 'a fresh conversation about a concrete project and recent progress', createdAt: at.toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }];
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  const trace = join(directory, 'calls.jsonl');
  const hook = join(directory, 'transport.mjs');
  const modules = ['model-client', 'ombre-client', 'bark-client', 'bridge-queue'].map(name => pathToFileURL(join(root, 'src', `${name}.js`)).href);
  await writeFile(hook, `
    import { appendFileSync } from 'node:fs';
    import { ModelClient } from ${JSON.stringify(modules[0])};
    import { OmbreClient } from ${JSON.stringify(modules[1])};
    import { BarkClient } from ${JSON.stringify(modules[2])};
    import { BridgeQueue } from ${JSON.stringify(modules[3])};
    const trace = ${JSON.stringify(trace)};
    const record = item => appendFileSync(trace, JSON.stringify(item)+'\\n');
    for (const [klass, methods] of [[ModelClient,['generateDream','generateDreamPush','generateThought','generateDaytimeEmergence']],
      [OmbreClient,['post','recentMaterial','thoughtMaterial','daytimeMaterial','storeDream']],
      [BarkClient,['send']],[BridgeQueue,['init','enqueue','ready']]]) {
      for (const name of methods) klass.prototype[name] = () => { record({legacy:klass.name+'.'+name}); throw new Error('legacy path invoked'); };
    }
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); const input = JSON.parse(body.messages[1].content);
      record({url,model:body.model,type:input.type,material:input.material});
      if (url !== 'https://api.deepseek.com/chat/completions' || body.model !== 'deepseek-v4-flash') throw new Error('unexpected route');
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({text:'saved internal '+input.type,
        wantsExpression:false,expressionIntent:'',dream:'a dream',residue:'a residue',awareness:'not reality',lucidity:0.5})}}]})};
    };
  `);
  const token = 'isolated-test-token-0123456789abcdef';
  let output = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, join(root, 'src/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SERVICE_TOKEN: token,
      STATE_PATH: join(directory, 'state.json'), TRANSITION_JOURNAL_PATH: join(directory, 'journal.jsonl'),
      OAUTH_STATE_PATH: join(directory, 'oauth.json'), BRIDGE_STATE_PATH: join(directory, 'bridge.json'),
      OMBRE_HEARTBEAT_FILE: join(directory, 'missing.json'), SETTLE_INTERVAL_MINUTES: '1440',
      SHADOW_MODE: 'true', EXPERIENCE_ENABLED: 'true', EXPERIENCE_MATERIAL_ENABLED: 'true',
      EXPERIENCE_THOUGHT_ENABLED: 'true', EXPERIENCE_DAYTIME_ENABLED: 'false', EXPERIENCE_HANDOFF_ENABLED: 'true',
      EXPERIENCE_MODEL_ENABLED: 'true', EXPERIENCE_MODEL_API_KEY: 'fake-only', EXPERIENCE_MODEL_NAME: 'deepseek-v4-flash',
      EXPERIENCE_MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_ENABLED: 'false', BARK_ENABLED: 'false', BRIDGE_ENABLED: 'false',
      OMBRE_READ_ENABLED: 'false', OMBRE_WRITE_ENABLED: 'false', CONTEXT_OMBRE_ENABLED: 'false',
      OAUTH_ENABLED: 'false', DASHBOARD_ENABLED: 'false', MCP_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode == null) { child.kill(); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) assert.fail(output);
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const response = await fetch(`${base}/v1/settle`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, await response.text());
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(item => item.type), ['dream', 'thought']);
  assert.ok(calls.every(item => !item.legacy && item.material.includes('fresh conversation')));
  const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(saved.proactive.experiences.dream.length, 1);
  assert.equal(saved.proactive.experiences.thought.length, 1);
  assert.equal(saved.proactive.events.length, 0);
  assert.deepEqual(saved.handoffNotes, state.handoffNotes);
  assert.match(output, /"shadow":true/);
});
