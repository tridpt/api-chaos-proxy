/**
 * 💉 ChaosForge v2.0 — 1-Line Embeddable Floating Chaos HUD (Shadow DOM)
 * Nhúng vào bất kỳ trang React / Vue / Next.js / HTML nào đang phát triển:
 *   <script src="http://localhost:4190/chaos-hud.js"></script>
 */
(function () {
  if (window.__CHAOSFORGE_HUD_MOUNTED__) return;
  window.__CHAOSFORGE_HUD_MOUNTED__ = true;

  const scriptEl = document.currentScript;
  let origin = 'http://localhost:4190';
  try {
    if (scriptEl && scriptEl.src) {
      origin = new URL(scriptEl.src).origin;
    }
  } catch {}

  const host = document.createElement('div');
  host.id = 'chaosforge-floating-hud';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .hud-wrap {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483640;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        color: #e6edf7;
      }
      .hud-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(15, 22, 36, 0.95);
        border: 1px solid #38bdf8;
        border-radius: 999px;
        padding: 7px 13px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        user-select: none;
      }
      .hud-pill:hover { filter: brightness(1.12); }
      .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #22c55e;
      }
      .dot.chaos { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
      .dot.offline { background: #a855f7; box-shadow: 0 0 8px #a855f7; }
      .hud-panel {
        display: none;
        width: 300px;
        margin-bottom: 8px;
        background: rgba(12, 18, 31, 0.97);
        border: 1px solid #364d77;
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6);
      }
      .hud-panel.open { display: block; }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid #24324d;
      }
      .head strong { font-size: 12.5px; color: #38bdf8; }
      .head a { color: #8ea0c0; text-decoration: none; font-size: 11px; }
      .head a:hover { color: #fff; }
      .stats {
        display: flex;
        justify-content: space-between;
        background: #162033;
        padding: 6px 8px;
        border-radius: 7px;
        margin-bottom: 8px;
        font-family: Consolas, monospace;
        font-size: 11px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      button {
        background: #162033;
        border: 1px solid #2b3c5e;
        color: #e6edf7;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        text-align: left;
      }
      button:hover { border-color: #38bdf8; background: #1d2a44; }
      .toast-msg {
        margin-top: 7px;
        font-size: 11px;
        color: #fde68a;
        min-height: 15px;
      }
    </style>
    <div class="hud-wrap">
      <div class="hud-panel" id="panel">
        <div class="head">
          <strong>⚡ ChaosForge Floating HUD</strong>
          <a href="${origin}" target="_blank" rel="noopener">Mở Cockpit ↗</a>
        </div>
        <div class="stats">
          <span id="stMode">MODE: --</span>
          <span id="stReq">0 req</span>
          <span id="stLat">0 ms</span>
        </div>
        <div class="grid">
          <button data-preset="clean">🟢 0ms Sạch</button>
          <button data-preset="elevator_3g">🟡 Lag 3G (3s)</button>
          <button data-preset="rate_limit_storm">🟠 Bão 429</button>
          <button data-preset="backend_fire">🔴 500 + Drop</button>
          <button data-preset="json_crasher">🟣 Đột biến JSON</button>
          <button id="btnOffline">📼 Phát Offline</button>
          <button id="btnExpire401">🔐 Hết hạn 401</button>
          <button id="btnKillWs">🔌 Cắt WebSocket</button>
        </div>
        <div class="toast-msg" id="msg">Sẵn sàng điều khiển Proxy :4191</div>
      </div>
      <div class="hud-pill" id="pill">
        <span class="dot" id="dot"></span>
        <strong>⚡ Chaos HUD</strong>
        <span id="pillLabel" style="color:#8ea0c0">CLEAN</span>
      </div>
    </div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const setMsg = (txt) => {
    $('msg').textContent = txt;
  };

  $('pill').addEventListener('click', () => {
    $('panel').classList.toggle('open');
  });

  async function callApi(path, body) {
    try {
      const r = await fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return await r.json();
    } catch (e) {
      setMsg('Không kết nối được ChaosForge :4190');
      return null;
    }
  }

  shadow.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await callApi('/api/preset', { presetId: btn.dataset.preset });
      if (res && res.ok) {
        syncUi(res.config);
        setMsg('Đã bật: ' + btn.textContent.trim());
      }
    });
  });

  $('btnOffline').addEventListener('click', async () => {
    const res = await callApi('/api/config', { mode: 'OFFLINE_REPLAY' });
    if (res && res.ok) {
      syncUi(res.config);
      setMsg('📼 Đã chuyển sang Phát lại Offline');
    }
  });

  $('btnExpire401').addEventListener('click', async () => {
    const res = await callApi('/api/auth-chaos/expire-now', {});
    if (res && res.ok) {
      setMsg('🔐 Đã làm hết hạn Token (Bẫy 401 Burst)!');
    }
  });

  $('btnKillWs').addEventListener('click', async () => {
    const res = await callApi('/api/ws/kill-all', {});
    if (res && res.ok) {
      setMsg(`🔌 Đã ngắt ${res.killed || 0} kết nối WebSocket!`);
    }
  });

  function syncUi(cfg) {
    if (!cfg) return;
    $('stMode').textContent = cfg.mode;
    $('pillLabel').textContent = cfg.mode === 'PASSTHROUGH' ? 'CLEAN' : cfg.mode === 'OFFLINE_REPLAY' ? 'OFFLINE' : 'CHAOS';
    const d = $('dot');
    d.className = 'dot' + (cfg.mode === 'CHAOS' ? ' chaos' : cfg.mode === 'OFFLINE_REPLAY' ? ' offline' : '');
  }

  fetch(origin + '/api/state')
    .then((r) => r.json())
    .then((d) => {
      if (d && d.ok) {
        syncUi(d.config);
        $('stReq').textContent = (d.telemetry?.totalRequests || 0) + ' req';
        $('stLat').textContent = (d.telemetry?.avgLatencyMs || 0) + ' ms';
      }
    })
    .catch(() => {});

  try {
    const es = new EventSource(origin + '/api/events');
    let reqCount = 0;
    es.addEventListener('state:updated', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.config) syncUi(d.config);
    });
    es.addEventListener('traffic:done', (ev) => {
      const tx = JSON.parse(ev.data);
      reqCount++;
      $('stReq').textContent = '+' + reqCount + ' req';
      $('stLat').textContent = tx.totalMs + ' ms';
    });
  } catch {}
})();
