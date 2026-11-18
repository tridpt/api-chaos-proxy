/**
 * End-to-End Smoke & Integration Test Suite for ChaosForge v2.0 (14 Tests)
 */

const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const TEST_COCKPIT_PORT = 14190;
const TEST_PROXY_PORT = 14191;
const COCKPIT_BASE = `http://127.0.0.1:${TEST_COCKPIT_PORT}`;
const PROXY_BASE = `http://127.0.0.1:${TEST_PROXY_PORT}`;

async function waitForServer(url, maxMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Server did not start in ${maxMs}ms`);
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

function testRawWebSocketHandshakeAndKill(port, cockpitBase) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n')
      );
    });

    let bufStr = '';
    let upgraded = false;
    socket.on('data', async (chunk) => {
      bufStr += chunk.toString('utf8');
      if (!upgraded && bufStr.includes('101 Switching Protocols') && bufStr.includes('welcome')) {
        upgraded = true;
        // Now trigger 1-click WebSocket Kill from Cockpit Control API!
        const killRes = await postJson(`${cockpitBase}/api/ws/kill-all`, {});
        assert.ok(killRes.data.killed >= 1, 'Expected at least 1 active WS killed');
      }
    });

    socket.on('close', () => {
      if (upgraded) resolve(true);
      else reject(new Error('WebSocket closed before 101 upgrade + welcome frame'));
    });

    socket.on('error', (err) => {
      if (upgraded) resolve(true);
      else reject(err);
    });
  });
}

async function runTests() {
  console.log('🧪 Starting ChaosForge v2.0 server on isolated test ports...');
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(TEST_COCKPIT_PORT), PROXY_PORT: String(TEST_PROXY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(`${COCKPIT_BASE}/api/state`);
    console.log('✅ 1. Cockpit Server & State API online');

    await postJson(`${COCKPIT_BASE}/api/preset`, { presetId: 'clean' });
    await postJson(`${COCKPIT_BASE}/api/config`, {
      targetUrl: `${COCKPIT_BASE}/demo-api`,
      recording: false,
      authChaos: { enabled: false },
      graphqlChaos: { enabled: false },
      streamChaos: { enabled: false },
      wsChaos: { enabled: false },
      breakpoints: { interceptRequest: false, interceptResponse: false }
    });

    // 2. Clean Reverse Proxy
    const prodRes = await fetch(`${PROXY_BASE}/products`);
    assert.strictEqual(prodRes.status, 200);
    assert.strictEqual(prodRes.headers.get('access-control-allow-origin'), '*');
    const prodJson = await prodRes.json();
    assert.strictEqual(prodJson.products.length, 4);
    console.log('✅ 2. Clean Reverse Proxy (:14191 -> /demo-api/products) + CORS verified');

    // 3. Dynamic Mock Route
    const flagJson = await (await fetch(`${PROXY_BASE}/feature-flags`)).json();
    assert.ok(flagJson.requestId && flagJson.requestId.length > 10);
    console.log('✅ 3. Dynamic Mock Route Rule ({{uuid}}, {{isoDate}}) verified');

    // 4. Chaos Latency + HTTP 429
    await postJson(`${COCKPIT_BASE}/api/config`, {
      mode: 'CHAOS',
      chaos: { latencyMs: 180, jitterMs: 0, errorRate: 100, errorCodes: [429], dropRate: 0, hangRate: 0 }
    });
    const t0 = performance.now();
    const errRes = await fetch(`${PROXY_BASE}/products`);
    const elapsed = performance.now() - t0;
    assert.strictEqual(errRes.status, 429);
    assert.strictEqual(errRes.headers.get('retry-after'), '2');
    assert.ok(elapsed >= 150);
    console.log(`✅ 4. Chaos Latency (${Math.round(elapsed)}ms) & HTTP 429 Fault verified`);

    // 5. Wire JSON Mutator
    await postJson(`${COCKPIT_BASE}/api/config`, {
      mode: 'CHAOS',
      chaos: { latencyMs: 0, errorRate: 0 },
      mutator: {
        enabled: true,
        mutationRate: 100,
        nullifyFields: true,
        targetKeys: 'products',
        truncateJson: false,
        jsonOverrides: '{"injectedFlag": "V2_OK"}'
      }
    });
    const mutJson = await (await fetch(`${PROXY_BASE}/products`)).json();
    assert.strictEqual(mutJson.products, null);
    assert.strictEqual(mutJson.injectedFlag, 'V2_OK');
    await postJson(`${COCKPIT_BASE}/api/config`, { mutator: { enabled: false } });
    console.log('✅ 5. JSON Edge-Case Mutator verified');

    // 6. Live Mid-Air Breakpoint
    await postJson(`${COCKPIT_BASE}/api/preset`, { presetId: 'clean' });
    await postJson(`${COCKPIT_BASE}/api/config`, {
      breakpoints: { interceptResponse: true, filterPattern: '/dashboard*' }
    });
    const inflight = fetch(`${PROXY_BASE}/dashboard/summary`);
    await new Promise((r) => setTimeout(r, 150));
    const bpList = await (await fetch(`${COCKPIT_BASE}/api/breakpoints`)).json();
    assert.strictEqual(bpList.breakpoints.length, 1);
    await postJson(`${COCKPIT_BASE}/api/breakpoints/${bpList.breakpoints[0].id}/resolve`, {
      action: 'resume',
      statusCode: 299,
      body: JSON.stringify({ surgicallyEdited: true })
    });
    const editedRes = await inflight;
    assert.strictEqual(editedRes.status, 299);
    await postJson(`${COCKPIT_BASE}/api/config`, { breakpoints: { interceptResponse: false } });
    console.log('✅ 6. Live Packet Breakpoint Surgeon verified');

    // 7. Cassette Recording & Offline Replay
    const newCas = await postJson(`${COCKPIT_BASE}/api/cassettes`, {
      name: 'Smoke V2 Cassette',
      activate: true,
      startRecording: true
    });
    const casId = newCas.data.cassette.id;
    await postJson(`${COCKPIT_BASE}/api/demo/reset`, {});
    await fetch(`${PROXY_BASE}/orders/track`);
    await fetch(`${PROXY_BASE}/orders/track`);
    await postJson(`${COCKPIT_BASE}/api/config`, {
      recording: false,
      mode: 'OFFLINE_REPLAY',
      targetUrl: 'http://127.0.0.1:19999/dead'
    });
    const rep1 = await (await fetch(`${PROXY_BASE}/orders/track`)).json();
    const rep2 = await (await fetch(`${PROXY_BASE}/orders/track`)).json();
    assert.strictEqual(rep1.step, 1);
    assert.strictEqual(rep2.step, 2);
    await fetch(`${COCKPIT_BASE}/api/cassettes/${casId}`, { method: 'DELETE' });
    await postJson(`${COCKPIT_BASE}/api/config`, {
      mode: 'CHAOS',
      activeCassetteId: 'cas-demo-baseline',
      targetUrl: `${COCKPIT_BASE}/demo-api`
    });
    console.log('✅ 7. Stateful Session Cassette Recording & Offline Replay verified');

    // 8. Idempotency Key Protection
    await postJson(`${COCKPIT_BASE}/api/demo/reset`, {});
    const id1 = await postJson(`${PROXY_BASE}/checkout`, { amount: 1000000 }, { 'X-Idempotency-Key': 'k-v2' });
    const id2 = await postJson(`${PROXY_BASE}/checkout`, { amount: 1000000 }, { 'X-Idempotency-Key': 'k-v2' });
    assert.strictEqual(id2.data.idempotentReplay, true);
    assert.strictEqual(id1.data.walletBalance, id2.data.walletBalance);
    console.log('✅ 8. Checkout Idempotency Protection verified');

    // 9. v2.0 AI SSE Stream Proxy + Corrupt Frame Injection
    await postJson(`${COCKPIT_BASE}/api/config`, {
      mode: 'CHAOS',
      streamChaos: { enabled: true, tokenDelayMs: 5, stallMidStreamMs: 0, dropMidStreamRate: 0, corruptEventRate: 100 }
    });
    const sseRes = await fetch(`${PROXY_BASE}/ai/stream?prompt=Hello`, {
      headers: { Accept: 'text/event-stream' }
    });
    assert.strictEqual(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('MALFORMED_TOKEN'), 'SSE Corrupt Frame injected mid-stream');
    assert.ok(sseText.includes('[DONE]'), 'SSE Stream completed');
    await postJson(`${COCKPIT_BASE}/api/config`, { streamChaos: { enabled: false } });
    console.log('✅ 9. AI SSE Token Stream Proxy & Mid-Stream Chaos Injection verified');

    // 10. v2.0 WebSocket Proxy Tunnel + Welcome Frame + Kill All WS
    await testRawWebSocketHandshakeAndKill(TEST_PROXY_PORT, COCKPIT_BASE);
    console.log('✅ 10. WebSocket Tunnel Upgrade (:14191 -> /demo-api/ws) & Kill-All verified');

    // 11. v2.0 401 Auth Burst Trap & Parallel Refresh Race-Condition Detector
    await postJson(`${COCKPIT_BASE}/api/demo/reset`, {});
    await postJson(`${COCKPIT_BASE}/api/auth-chaos/expire-now`, {});
    const p401 = await fetch(`${PROXY_BASE}/protected/widget?slot=1`, {
      headers: { Authorization: 'Bearer old_tok' }
    });
    assert.strictEqual(p401.status, 401, 'Armed 401 trap returned 401');

    // Fire 3 overlapping refresh requests -> must detect Refresh Race!
    await Promise.all([
      postJson(`${PROXY_BASE}/auth/refresh`, {}),
      postJson(`${PROXY_BASE}/auth/refresh`, {}),
      postJson(`${PROXY_BASE}/auth/refresh`, {})
    ]);
    const stAfterAuth = await (await fetch(`${COCKPIT_BASE}/api/state`)).json();
    assert.ok(stAfterAuth.telemetry.authRaceIncidents >= 1, 'Detected parallel /auth/refresh race condition');
    const pAfterRefresh = await fetch(`${PROXY_BASE}/protected/widget?slot=1`, {
      headers: { Authorization: 'Bearer new_tok' }
    });
    assert.strictEqual(pAfterRefresh.status, 200, 'Protected route succeeded after refresh');
    await postJson(`${COCKPIT_BASE}/api/config`, { authChaos: { enabled: false } });
    console.log('✅ 11. Auth 401 Burst Trap & Refresh Token Race Detector verified');

    // 12. v2.0 GraphQL Operation-Aware Partial Data Chaos
    await postJson(`${COCKPIT_BASE}/api/config`, {
      mode: 'CHAOS',
      graphqlChaos: { enabled: true, targetOperations: 'GetWalletDashboard', errors200Rate: 0, partialDataRate: 100 }
    });
    const gqlRes = await postJson(`${PROXY_BASE}/graphql`, {
      operationName: 'GetWalletDashboard',
      query: 'query GetWalletDashboard { wallet { balance } featuredProducts { id } }'
    });
    assert.strictEqual(gqlRes.status, 200);
    assert.strictEqual(gqlRes.data.data.wallet, null, 'Root field wallet nulled in Partial Data Chaos');
    assert.ok(Array.isArray(gqlRes.data.errors) && gqlRes.data.errors.length > 0, 'GraphQL errors[] attached');
    await postJson(`${COCKPIT_BASE}/api/config`, { graphqlChaos: { enabled: false } });
    console.log('✅ 12. GraphQL Operation-Aware Partial Data + Errors Chaos verified');

    // 13. v2.0 Chrome .HAR Export/Import & Auto-OpenAPI 3.0.3 Harvester
    const exportedHar = await (await fetch(`${COCKPIT_BASE}/api/har/export?source=traffic`)).json();
    assert.strictEqual(exportedHar.log.version, '1.2');
    assert.ok(exportedHar.log.entries.length >= 5);

    const harImportRes = await postJson(`${COCKPIT_BASE}/api/har/import`, {
      har: exportedHar,
      name: 'Imported HAR Smoke',
      activate: false
    });
    assert.strictEqual(harImportRes.status, 201);
    assert.ok(harImportRes.data.importedCount >= 5);
    await fetch(`${COCKPIT_BASE}/api/cassettes/${harImportRes.data.cassette.id}`, { method: 'DELETE' });

    const openApiRes = await (await fetch(`${COCKPIT_BASE}/api/openapi`)).json();
    assert.strictEqual(openApiRes.spec.openapi, '3.0.3');
    assert.ok(openApiRes.endpointCount >= 4, `Harvested ${openApiRes.endpointCount} OpenAPI paths`);
    console.log(`✅ 13. Chrome .HAR Roundtrip & Auto-OpenAPI 3.0.3 Harvester (${openApiRes.endpointCount} paths) verified`);

    // 14. v2.0 Timeline Storyboard Start/Stop, Markdown Report & Floating HUD Script
    const tlStart = await postJson(`${COCKPIT_BASE}/api/timeline/start`, { templateId: 'flash_sale_gameday' });
    assert.strictEqual(tlStart.data.ok, true);
    await new Promise((r) => setTimeout(r, 250));
    const tlStop = await postJson(`${COCKPIT_BASE}/api/timeline/stop`, {});
    assert.strictEqual(tlStop.data.ok, true);

    const mdRes = await (await fetch(`${COCKPIT_BASE}/api/report/markdown`)).json();
    assert.ok(mdRes.markdown.includes('ChaosForge v2.0'));

    const hudScript = await (await fetch(`${COCKPIT_BASE}/chaos-hud.js`)).text();
    assert.ok(hudScript.includes('__CHAOSFORGE_HUD_MOUNTED__'));

    // Reset clean default config for port 4190 before closing
    await postJson(`${COCKPIT_BASE}/api/demo/reset`, {});
    await postJson(`${COCKPIT_BASE}/api/preset`, { presetId: 'clean' });
    await postJson(`${COCKPIT_BASE}/api/config`, {
      targetUrl: 'http://127.0.0.1:4190/demo-api',
      activeCassetteId: 'cas-demo-baseline'
    });
    console.log('✅ 14. Timeline Storyboard, Markdown Report & Floating HUD Script verified');

    console.log('\n🎉 ALL 14 CHAOSFORGE v2.0 END-TO-END TESTS PASSED SUCCESSFULLY!');
  } finally {
    proc.kill();
  }
}

runTests().catch((err) => {
  console.error('❌ v2.0 SMOKE TEST FAILED:', err);
  process.exit(1);
});
