/**
 * ⚡ ChaosForge v2.0 Cockpit Client
 * Controls: HTTP/JSON Chaos, AI SSE & WebSocket Chaos, 401 Refresh Race Trap,
 * GraphQL Chaos, Timeline Storyboards, .HAR + OpenAPI 3.0 & Crash-Test SuperApp
 */

const state = {
  ports: { cockpit: 4190, proxy: 4191 },
  config: null,
  presets: {},
  rules: [],
  cassettes: [],
  activeCassetteDetail: null,
  selectedCassetteEntryId: null,
  breakpoints: [],
  telemetry: {},
  timeline: { running: false, templates: {} },
  lastOpenApiSpec: null,
  lastMarkdownReport: '',
  traffic: [],
  selectedTxId: null,
  uiArmorMode: 'FRAGILE', // 'FRAGILE' | 'RESILIENT'
  checkoutInFlight: false,
  victimToken: 'tok_initial_demo',
  refreshMutexPromise: null,
  victimWs: null,
  victimWsWanted: false,
  victimWsReconnectTimer: null,
  lastKnownGoodSummary: null,
  lastKnownGoodProducts: null,
  bpTimerInterval: null
};

function getProxyBaseUrl() {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:${state.ports.proxy || 4191}`;
}

function getProxyWsUrl() {
  const host = window.location.hostname || 'localhost';
  return `ws://${host}:${state.ports.proxy || 4191}`;
}

// ============================================================================
// 1. API HELPERS & TOASTS
// ============================================================================

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  return res.json();
}

function showToast(msg, borderColor = '#38bdf8') {
  const wrap = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeftColor = borderColor;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s';
    setTimeout(() => el.remove(), 260);
  }, 3400);
}

function formatMoneyVnd(val) {
  if (typeof val !== 'number' || Number.isNaN(val)) return String(val) + ' ₫';
  return val.toLocaleString('vi-VN') + ' ₫';
}

function formatTimeShort(iso) {
  if (!iso) return '--:--:--';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });
}

function prettyJsonOrRaw(str) {
  if (!str) return '(Trống)';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function downloadBlob(contentStr, filename, mime = 'application/json') {
  const blob = new Blob([contentStr], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ============================================================================
// 2. INITIALIZATION & SSE REALTIME STREAM
// ============================================================================

async function initApp() {
  bindStaticEvents();
  const data = await api('/api/state');
  if (data.ok) {
    state.ports = data.ports || state.ports;
    state.config = data.config;
    state.presets = data.presets || {};
    state.rules = data.rules || [];
    state.cassettes = data.cassettes || [];
    state.breakpoints = data.breakpoints || [];
    state.telemetry = data.telemetry || {};
    state.timeline = data.timeline || { running: false, templates: {} };
    state.traffic = data.traffic || [];

    document.getElementById('proxyGatewayUrl').textContent = getProxyBaseUrl();
    renderAll();
    if (state.cassettes.length > 0) {
      loadCassetteDetail(state.config.activeCassetteId || state.cassettes[0].id);
    }
  }
  connectSse();
  victimLoadStoreData();
}

function connectSse() {
  const statusEl = document.getElementById('sseStatusText');
  const es = new EventSource('/api/events');

  es.addEventListener('connected', () => {
    statusEl.textContent = '● Live Stream Đang Hoạt Động';
    statusEl.className = 'metric-sub text-green';
  });

  es.onerror = () => {
    statusEl.textContent = '○ Đang kết nối lại SSE...';
    statusEl.className = 'metric-sub text-warning';
  };

  es.addEventListener('state:updated', (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.config) {
      state.config = payload.config;
      renderConfigControls();
      renderPresets();
      renderCassettesList();
    }
    if (payload.rules) {
      state.rules = payload.rules;
      renderRulesList();
    }
  });

  es.addEventListener('traffic:done', (ev) => {
    const tx = JSON.parse(ev.data);
    state.traffic.unshift(tx);
    if (state.traffic.length > 250) state.traffic.pop();
    recomputeTelemetryLocal();
    renderTelemetry();
    renderTrafficTable();
    if (!state.selectedTxId) selectTrafficItem(tx.id);
  });

  es.addEventListener('traffic:cleared', () => {
    state.traffic = [];
    state.selectedTxId = null;
    recomputeTelemetryLocal();
    renderTelemetry();
    renderTrafficTable();
    renderInspector();
  });

  es.addEventListener('breakpoint:paused', (ev) => {
    const bp = JSON.parse(ev.data);
    if (!state.breakpoints.some((b) => b.id === bp.id)) state.breakpoints.push(bp);
    renderBreakpointDrawer();
    showToast(`⏸ Đã bắt sống gói tin [${bp.method} ${bp.fullPath}]!`, '#f59e0b');
  });

  es.addEventListener('breakpoint:resolved', (ev) => {
    const info = JSON.parse(ev.data);
    state.breakpoints = state.breakpoints.filter((b) => b.id !== info.id);
    renderBreakpointDrawer();
  });

  es.addEventListener('cassette:updated', async (ev) => {
    const info = JSON.parse(ev.data);
    const metaRes = await api('/api/cassettes');
    if (metaRes.ok) {
      state.cassettes = metaRes.cassettes;
      renderCassettesList();
    }
    if (state.activeCassetteDetail && state.activeCassetteDetail.id === info.cassetteId) {
      loadCassetteDetail(info.cassetteId);
    }
  });

  es.addEventListener('demo:double_submit', (ev) => {
    const d = JSON.parse(ev.data);
    state.telemetry.doubleSubmitIncidents = d.incidents;
    renderTelemetry();
    flashRaceCard();
    showToast(`⚠️ CẢNH BÁO DOUBLE-SUBMIT: Trừ tiền lặp lần #${d.incidents}!`, '#ef4444');
  });

  es.addEventListener('auth:race_detected', (ev) => {
    const d = JSON.parse(ev.data);
    state.telemetry.authRaceIncidents = d.incidents;
    renderTelemetry();
    flashRaceCard();
    showToast(`🚨 PHÁT HIỆN BÃO REFRESH 401: ${d.parallelCount} gọi /auth/refresh chồng chéo!`, '#ef4444');
  });

  es.addEventListener('ws:open', (ev) => {
    const d = JSON.parse(ev.data);
    state.telemetry.activeWsCount = d.activeCount;
    renderTelemetry();
  });

  es.addEventListener('ws:close', (ev) => {
    const d = JSON.parse(ev.data);
    state.telemetry.activeWsCount = d.activeCount;
    renderTelemetry();
  });

  es.addEventListener('ws:killed_all', () => {
    state.telemetry.activeWsCount = 0;
    renderTelemetry();
  });

  // Timeline Storyboard Live Events
  es.addEventListener('timeline:tick', (ev) => {
    const d = JSON.parse(ev.data);
    state.timeline.running = true;
    updateTimelineBanner(d);
  });

  es.addEventListener('timeline:stage', (ev) => {
    const d = JSON.parse(ev.data);
    showToast(`🎬 Kịch bản chuyển sang: ${d.stageName}`, '#a855f7');
  });

  es.addEventListener('timeline:done', async (ev) => {
    const d = JSON.parse(ev.data);
    state.timeline.running = false;
    document.getElementById('timelineLiveBanner').classList.add('hidden');
    document.getElementById('btnStopTimeline').classList.add('hidden');
    showToast(`🏁 Đã hoàn tất kịch bản GameDay (${d.reason})! Đã khôi phục cấu hình.`, '#22c55e');
    await refreshMarkdownReport();
  });
}

function flashRaceCard() {
  const card = document.getElementById('doubleSubmitCard');
  card.classList.add('alert-flash');
  setTimeout(() => card.classList.remove('alert-flash'), 2500);
}

function updateTimelineBanner(d) {
  const banner = document.getElementById('timelineLiveBanner');
  banner.classList.remove('hidden');
  document.getElementById('btnStopTimeline').classList.remove('hidden');
  document.getElementById('tlBannerName').textContent = d.name;
  document.getElementById('tlBannerStage').textContent = d.currentStageName;
  document.getElementById('tlBannerClock').textContent = `${d.elapsedSec.toFixed(1)}s / ${d.totalSec}s`;
  const pct = Math.min(100, Math.round((d.elapsedSec / Math.max(1, d.totalSec)) * 100));
  document.getElementById('tlBannerBar').style.width = `${pct}%`;
}

function recomputeTelemetryLocal() {
  const total = state.traffic.length;
  if (total === 0) {
    state.telemetry = {
      ...state.telemetry,
      totalRequests: 0, errorCount: 0, errorRatePct: 0,
      mutatedCount: 0, clientAbortedCount: 0, avgLatencyMs: 0, p95LatencyMs: 0
    };
    return;
  }
  let err = 0;
  let mut = 0;
  let abt = 0;
  const lats = [];
  for (const t of state.traffic) {
    if (t.statusCode >= 400 || t.statusCode === 0) err++;
    if (t.mutationsApplied && t.mutationsApplied.length > 0) mut++;
    if (t.clientAborted) abt++;
    lats.push(t.totalMs || 0);
  }
  lats.sort((a, b) => a - b);
  const sum = lats.reduce((a, b) => a + b, 0);
  state.telemetry = {
    ...state.telemetry,
    totalRequests: total,
    errorCount: err,
    errorRatePct: Math.round((err / total) * 100),
    mutatedCount: mut,
    clientAbortedCount: abt,
    avgLatencyMs: Math.round(sum / total),
    p95LatencyMs: lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] || 0
  };
}

// ============================================================================
// 3. RENDER COCKPIT UI
// ============================================================================

function renderAll() {
  renderTelemetry();
  renderPresets();
  renderConfigControls();
  renderTrafficTable();
  renderInspector();
  renderRulesList();
  renderCassettesList();
  renderTimelineTemplates();
  renderBreakpointDrawer();
}

function renderTelemetry() {
  const m = state.telemetry || {};
  document.getElementById('mTotalReq').textContent = m.totalRequests || 0;
  document.getElementById('mAvgLat').textContent = m.avgLatencyMs || 0;
  document.getElementById('mP95Lat').textContent = `${m.p95LatencyMs || 0} ms`;
  document.getElementById('mErrRate').textContent = m.errorRatePct || 0;
  document.getElementById('mErrCount').textContent = m.errorCount || 0;
  document.getElementById('mMutatedCount').textContent = m.mutatedCount || 0;
  document.getElementById('mWsCount').textContent = m.activeWsCount || 0;
  document.getElementById('mAbortedCount').textContent = m.clientAbortedCount || 0;
  document.getElementById('mDoubleSubmit').textContent = m.doubleSubmitIncidents || 0;
  document.getElementById('mAuthRace').textContent = m.authRaceIncidents || 0;
}

function renderPresets() {
  const wrap = document.getElementById('presetsGrid');
  wrap.innerHTML = '';
  const activeId = state.config ? state.config.activePreset : '';

  for (const preset of Object.values(state.presets)) {
    const card = document.createElement('div');
    card.className = 'preset-card' + (preset.id === activeId ? ' active' : '');
    card.innerHTML = `
      <div class="preset-card-title">${preset.name}</div>
      <div class="preset-card-desc">${preset.description}</div>
    `;
    card.addEventListener('click', async () => {
      const res = await api('/api/preset', {
        method: 'POST',
        body: JSON.stringify({ presetId: preset.id })
      });
      if (res.ok) {
        state.config = res.config;
        renderConfigControls();
        renderPresets();
        showToast(`Đã kích hoạt kịch bản: ${preset.name}`);
      }
    });
    wrap.appendChild(card);
  }
}

function renderConfigControls() {
  const cfg = state.config;
  if (!cfg) return;

  const targetInp = document.getElementById('inputTargetUrl');
  if (document.activeElement !== targetInp) targetInp.value = cfg.targetUrl || '';

  document.querySelectorAll('#modeSwitch .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === cfg.mode);
  });

  const recBtn = document.getElementById('btnToggleRecord');
  recBtn.classList.toggle('recording', Boolean(cfg.recording));
  document.getElementById('recLabel').textContent = cfg.recording ? 'ĐANG GHI BĂNG' : 'REC';

  const bpActive = Boolean(cfg.breakpoints.interceptResponse || cfg.breakpoints.interceptRequest);
  document.getElementById('btnQuickBreakpoint').classList.toggle('active', bpActive);

  const ch = cfg.chaos;
  setSlider('rngLatencyMs', 'valLatencyMs', ch.latencyMs, `${ch.latencyMs} ms`);
  setSlider('rngJitterMs', 'valJitterMs', ch.jitterMs, `${ch.jitterMs} ms`);
  setSlider('rngSpikeRate', 'valSpikeRate', ch.spikeRate, `${ch.spikeRate}%`);
  setSlider('rngErrorRate', 'valErrorRate', ch.errorRate, `${ch.errorRate}%`);
  setSlider('rngDropRate', 'valDropRate', ch.dropRate, `${ch.dropRate}%`);
  setSlider('rngHangRate', 'valHangRate', ch.hangRate, `${ch.hangRate}%`);
  setSlider('rngThrottleKbps', 'valThrottleKbps', ch.throttleKbps, ch.throttleKbps > 0 ? `${ch.throttleKbps} KB/s` : 'Không giới hạn');
  setSlider('rngStripCorsRate', 'valStripCorsRate', ch.stripCorsRate || 0, `${ch.stripCorsRate || 0}%`);

  document.getElementById('chkCorsBypass').checked = Boolean(cfg.corsBypass);

  const codeSet = new Set((ch.errorCodes || []).map(Number));
  document.querySelectorAll('#errorCodeChips input[type="checkbox"]').forEach((cb) => {
    cb.checked = codeSet.has(Number(cb.value));
  });

  const mut = cfg.mutator;
  document.getElementById('chkMutatorEnabled').checked = Boolean(mut.enabled);
  document.getElementById('chkMutNullify').checked = Boolean(mut.nullifyFields);
  document.getElementById('chkMutEmptyArr').checked = Boolean(mut.emptyArrays);
  document.getElementById('chkMutOverflow').checked = Boolean(mut.overflowStrings);
  document.getElementById('chkMutTypeConfuse').checked = Boolean(mut.typeConfusion);
  document.getElementById('chkMutTruncate').checked = Boolean(mut.truncateJson);
  document.getElementById('chkMutHtml').checked = Boolean(mut.htmlInsteadOfJson);

  setInputIfIdle('inpMutTargetKeys', mut.targetKeys || '');
  setInputIfIdle('inpJsonOverrides', mut.jsonOverrides || '{}');

  // v2.0 Stream & WS Chaos
  const sc = cfg.streamChaos || {};
  document.getElementById('chkStreamChaos').checked = Boolean(sc.enabled);
  setInputIfIdle('inpStreamTokenDelay', sc.tokenDelayMs ?? 60);
  setInputIfIdle('inpStreamStallMs', sc.stallMidStreamMs ?? 2200);
  setInputIfIdle('inpStreamDropRate', sc.dropMidStreamRate ?? 0);
  setInputIfIdle('inpStreamCorruptRate', sc.corruptEventRate ?? 0);

  const wc = cfg.wsChaos || {};
  document.getElementById('chkWsChaos').checked = Boolean(wc.enabled);
  setInputIfIdle('inpWsDelayMs', wc.frameDelayMs ?? 0);
  setInputIfIdle('inpWsAutoDropSec', wc.autoDropAfterSec ?? 0);

  // v2.0 GraphQL Chaos
  const gc = cfg.graphqlChaos || {};
  document.getElementById('chkGqlChaos').checked = Boolean(gc.enabled);
  setInputIfIdle('inpGqlTargets', gc.targetOperations || '*');
  setInputIfIdle('inpGqlErrorsRate', gc.errors200Rate ?? 0);
  setInputIfIdle('inpGqlPartialRate', gc.partialDataRate ?? 100);

  // Breakpoint strip
  document.getElementById('chkBpRes').checked = Boolean(cfg.breakpoints.interceptResponse);
  document.getElementById('chkBpReq').checked = Boolean(cfg.breakpoints.interceptRequest);
  setInputIfIdle('inpBpPattern', cfg.breakpoints.filterPattern || '*');

  // Offline options
  document.getElementById('chkReplayLatency').checked = Boolean(cfg.replayPreserveLatency);
  document.getElementById('chkReplayChaos').checked = Boolean(cfg.replayApplyChaos);
  document.getElementById('chkAutoFallbackOffline').checked = Boolean(cfg.autoFallbackOffline);
}

function setInputIfIdle(id, val) {
  const el = document.getElementById(id);
  if (el && document.activeElement !== el) el.value = val;
}

function setSlider(sliderId, labelId, val, text) {
  const s = document.getElementById(sliderId);
  const l = document.getElementById(labelId);
  if (s) s.value = val || 0;
  if (l) l.textContent = text;
}

// ============================================================================
// 4. TRAFFIC STREAM & DIFF INSPECTOR
// ============================================================================

function renderTrafficTable() {
  const tbody = document.getElementById('trafficTableBody');
  const q = document.getElementById('inpTrafficFilter').value.trim().toLowerCase();
  const filterType = document.getElementById('selTrafficFilterType').value;

  const filtered = state.traffic.filter((t) => {
    if (filterType === 'CHAOS' && (!t.chaosBadges || t.chaosBadges.length === 0) && t.statusCode < 400) return false;
    if (filterType === 'MUTATED' && (!t.mutationsApplied || t.mutationsApplied.length === 0)) return false;
    if (filterType === 'ERR' && t.statusCode > 0 && t.statusCode < 400) return false;

    if (!q) return true;
    const hay = `${t.method} ${t.fullPath} ${t.graphqlOperation || ''} ${t.statusCode} ${t.source} ${(t.chaosBadges || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });

  document.getElementById('trafficCountLabel').textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Không có gói tin khớp bộ lọc hiện tại.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .slice(0, 120)
    .map((t) => {
      const stClass =
        t.statusCode === 0 ? 'st-drop' : t.statusCode >= 500 ? 'st-5xx' : t.statusCode >= 400 ? 'st-4xx' : 'st-2xx';
      const stLabel = t.statusCode === 0 ? (t.clientAborted ? 'ABORT' : 'DROP') : t.statusCode;
      const pathLabel = t.graphqlOperation ? `${t.path} (${t.graphqlOperation})` : t.fullPath;

      const badgesHtml = (t.chaosBadges || [])
        .map((b) => {
          const cls =
            b.includes('FAULT') || b.includes('RESET') || b.includes('ERR') || b.includes('RACE') || b.includes('DROP')
              ? 'chaos-tag fault'
              : b.includes('ABORT') || b.includes('SSE')
              ? 'chaos-tag abort'
              : 'chaos-tag';
          return `<span class="${cls}">${escapeHtml(b)}</span>`;
        })
        .join('');

      return `
        <tr data-tx-id="${t.id}" class="${t.id === state.selectedTxId ? 'selected' : ''}">
          <td><code>${formatTimeShort(t.timestamp)}</code></td>
          <td><span class="method-badge m-${t.method}">${t.method}</span></td>
          <td title="${escapeHtml(pathLabel)}"><code>${escapeHtml(pathLabel.slice(0, 44))}</code></td>
          <td><small>${escapeHtml(t.source)}</small></td>
          <td><span class="status-pill ${stClass}">${stLabel}</span></td>
          <td><code>${t.totalMs}ms</code></td>
          <td>${badgesHtml || '<span class="text-muted">—</span>'}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('tr[data-tx-id]').forEach((row) => {
    row.addEventListener('click', () => selectTrafficItem(row.dataset.txId));
  });
}

function selectTrafficItem(txId) {
  state.selectedTxId = txId;
  renderTrafficTable();
  renderInspector();
}

function renderInspector() {
  const tx = state.traffic.find((t) => t.id === state.selectedTxId);
  const emptyEl = document.getElementById('inspectorEmpty');
  const contentEl = document.getElementById('inspectorContent');
  const btns = ['btnReplaySelected', 'btnCreateRuleFromTx', 'btnCopyCurl'];

  if (!tx) {
    emptyEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    btns.forEach((id) => (document.getElementById(id).disabled = true));
    return;
  }

  emptyEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
  btns.forEach((id) => (document.getElementById(id).disabled = false));

  document.getElementById('txSummaryBar').innerHTML = `
    <span class="method-badge m-${tx.method}">${tx.method}</span>
    <strong>${escapeHtml(tx.fullPath)}</strong>
    ${tx.graphqlOperation ? `<span class="chaos-tag">GQL: ${escapeHtml(tx.graphqlOperation)}</span>` : ''}
    <span>➔ Status: <b>${tx.statusCode || 'DROPPED'}</b></span>
    <span>· Nguồn: <b>${escapeHtml(tx.source)}</b></span>
  `;

  document.getElementById('txTimingBreakdown').innerHTML = `
    <span>⏱️ Tổng: <b>${tx.totalMs} ms</b></span>
    <span>🌐 Chaos Delay: <b class="text-warning">${tx.chaosDelayMs || 0} ms</b></span>
    <span>🎯 Upstream: <b class="text-cyan">${tx.upstreamMs || 0} ms</b></span>
    ${tx.breakpointMs ? `<span>⏸ Giữ Breakpoint: <b>${tx.breakpointMs} ms</b></span>` : ''}
    ${tx.throttleMs ? `<span>🐌 Bóp băng thông: <b>${tx.throttleMs} ms</b></span>` : ''}
  `;

  const mutBanner = document.getElementById('mutationBanner');
  const origWrap = document.getElementById('origBoxWrap');
  const diffCols = document.getElementById('diffColumnsWrap');

  const wasMutated =
    (tx.mutationsApplied && tx.mutationsApplied.length > 0) ||
    (tx.originalResBody && tx.originalResBody !== tx.resBody);

  if (wasMutated) {
    mutBanner.classList.remove('hidden');
    mutBanner.innerHTML = `🧬 <b>Biến đổi trên đường truyền:</b> ${(tx.mutationsApplied || ['EDITED']).join(' · ')}`;
    origWrap.classList.remove('hidden');
    diffCols.classList.remove('single-col');
    document.getElementById('preOrigBody').textContent = prettyJsonOrRaw(tx.originalResBody);
  } else {
    mutBanner.classList.add('hidden');
    origWrap.classList.add('hidden');
    diffCols.classList.add('single-col');
  }

  document.getElementById('preFinalBody').textContent = prettyJsonOrRaw(tx.resBody);
  document.getElementById('preReqBody').textContent = prettyJsonOrRaw(tx.reqBody);

  const fetchCode = [
    `const res = await fetch('${getProxyBaseUrl()}${tx.fullPath}', {`,
    `  method: '${tx.method}',`,
    tx.reqBody
      ? `  headers: { 'Content-Type': 'application/json' },\n  body: ${JSON.stringify(tx.reqBody)}`
      : `  headers: { 'Accept': 'application/json' }`,
    `});`,
    `const data = await res.json();`
  ].join('\n');
  document.getElementById('preFetchSnippet').textContent = fetchCode;

  document.getElementById('preReqHeaders').textContent = JSON.stringify(tx.reqHeaders || {}, null, 2);
  document.getElementById('preResHeaders').textContent = JSON.stringify(tx.resHeaders || {}, null, 2);
}

// ============================================================================
// 5. TIMELINE STORYBOARDS, MARKDOWN REPORT & AUTO-OPENAPI 3.0 (v2.0)
// ============================================================================

function renderTimelineTemplates() {
  const wrap = document.getElementById('timelineTemplatesList');
  const templates = state.timeline?.templates || {};
  const entries = Object.values(templates);
  if (entries.length === 0) return;

  wrap.innerHTML = entries
    .map((tpl) => {
      const stagesDesc = tpl.stages.map((s) => `${s.name} (${s.durationSec}s)`).join(' ➔ ');
      return `
        <div class="rule-item">
          <div style="flex:1;">
            <div style="font-weight:700;margin-bottom:3px;">${escapeHtml(tpl.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">${escapeHtml(tpl.description)}</div>
            <div style="font-size:11px;color:#a5b4fc;">${escapeHtml(stagesDesc)}</div>
          </div>
          <button class="btn btn-primary" data-start-tl="${tpl.id}">▶️ Chạy Kịch Bản</button>
        </div>
      `;
    })
    .join('');

  wrap.querySelectorAll('button[data-start-tl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api('/api/timeline/start', {
        method: 'POST',
        body: JSON.stringify({ templateId: btn.dataset.startTl })
      });
      if (res.ok) {
        showToast(`🎬 Bắt đầu chạy GameDay: ${res.run.name}!`, '#a855f7');
      }
    });
  });
}

async function refreshMarkdownReport() {
  const res = await api('/api/report/markdown');
  if (res.ok) {
    state.lastMarkdownReport = res.markdown;
    document.getElementById('preMarkdownReport').textContent = res.markdown;
  }
}

async function harvestOpenApiNow() {
  const res = await api('/api/openapi');
  if (res.ok) {
    state.lastOpenApiSpec = res.spec;
    const pill = document.getElementById('openApiSummaryPill');
    pill.classList.remove('hidden');
    pill.innerHTML = `✅ Đã quét <b>${res.analyzedSamples}</b> mẫu JSON và suy luận thành công <b>${res.endpointCount}</b> đường dẫn chuẩn OpenAPI 3.0.3!`;
    document.getElementById('preOpenApiSpec').textContent = JSON.stringify(res.spec, null, 2);
    showToast(`📐 Đã rút trích ${res.endpointCount} endpoints sang OpenAPI 3.0!`);
  }
}

// ============================================================================
// 6. BREAKPOINT SURGEON, RULES & CASSETTES + CHROME .HAR
// ============================================================================

function renderBreakpointDrawer() {
  const drawer = document.getElementById('breakpointDrawer');
  const badge = document.getElementById('bpCountBadge');
  const count = state.breakpoints.length;

  if (count === 0) {
    drawer.classList.add('hidden');
    badge.classList.add('hidden');
    if (state.bpTimerInterval) {
      clearInterval(state.bpTimerInterval);
      state.bpTimerInterval = null;
    }
    return;
  }

  badge.textContent = count;
  badge.classList.remove('hidden');
  drawer.classList.remove('hidden');

  const current = state.breakpoints[0];
  document.getElementById('bpQueueInfo').textContent = `${count} gói đang chờ`;
  document.getElementById('bpMetaSubtitle').textContent = `Đang giữ [${current.phase.toUpperCase()}] của ${current.method} ${current.fullPath} — Sửa JSON rồi bấm Phóng!`;

  const editor = document.getElementById('bpBodyEditor');
  if (editor.dataset.bpId !== current.id) {
    editor.dataset.bpId = current.id;
    editor.dataset.origBody = current.originalBody || current.body || '';
    document.getElementById('bpStatusInput').value = current.statusCode || 200;
    editor.value = prettyJsonOrRaw(current.body || '');
    validateBpJson();
  }

  if (!state.bpTimerInterval) {
    state.bpTimerInterval = setInterval(() => {
      if (state.breakpoints.length === 0) return;
      const bp = state.breakpoints[0];
      const secLeft = Math.max(0, Math.ceil((bp.expiresAt - Date.now()) / 1000));
      document.getElementById('bpCountdown').textContent = `Tự phóng sau: ${secLeft}s`;
    }, 500);
  }
}

function validateBpJson() {
  const val = document.getElementById('bpBodyEditor').value;
  const pill = document.getElementById('bpJsonValidity');
  try {
    JSON.parse(val);
    pill.textContent = '✓ JSON Hợp lệ';
    pill.className = 'json-valid-pill ok';
  } catch {
    pill.textContent = '⚠️ JSON Hỏng Cú Pháp (Test lỗi parse)';
    pill.className = 'json-valid-pill invalid';
  }
}

async function resolveCurrentBreakpoint(action) {
  if (state.breakpoints.length === 0) return;
  const current = state.breakpoints[0];
  const statusCode = Number(document.getElementById('bpStatusInput').value) || 200;
  const contentType = document.getElementById('bpContentTypeInput').value;
  const body = document.getElementById('bpBodyEditor').value;

  const payload =
    current.phase === 'request' && action === 'short_circuit'
      ? { action: 'short_circuit', statusCode, contentType, body }
      : { action, statusCode, contentType, body };

  await api(`/api/breakpoints/${current.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  state.breakpoints = state.breakpoints.filter((b) => b.id !== current.id);
  renderBreakpointDrawer();
}

function renderRulesList() {
  document.getElementById('rulesCountTab').textContent = state.rules.length;
  const wrap = document.getElementById('rulesListContainer');
  if (state.rules.length === 0) {
    wrap.innerHTML = `<div class="empty-cell">Chưa có luật nào.</div>`;
    return;
  }

  wrap.innerHTML = state.rules
    .map(
      (r) => `
      <div class="rule-item">
        <div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span class="method-badge m-${r.method === 'ALL' ? 'GET' : r.method}">${r.method}</span>
            <code>${escapeHtml(r.pathPattern)}</code>
            <span class="chaos-tag">${r.action}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);">
            ${escapeHtml(r.name)} · Status <b>${r.statusCode}</b>
            ${r.delayMs ? ` · Delay <b>${r.delayMs}ms</b>` : ''}
            ${r.errorRate ? ` · Lỗi <b>${r.errorRate}%</b>` : ''}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label class="inline-check">
            <input type="checkbox" data-toggle-rule="${r.id}" ${r.enabled ? 'checked' : ''} /> Bật
          </label>
          <button class="btn-mini" data-edit-rule="${r.id}">Sửa</button>
          <button class="btn-mini" data-del-rule="${r.id}">✕</button>
        </div>
      </div>
    `
    )
    .join('');

  wrap.querySelectorAll('input[data-toggle-rule]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const res = await api(`/api/rules/${cb.dataset.toggleRule}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: cb.checked })
      });
      if (res.ok) {
        state.rules = res.rules;
        renderRulesList();
      }
    });
  });

  wrap.querySelectorAll('button[data-edit-rule]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = state.rules.find((x) => x.id === btn.dataset.editRule);
      if (!r) return;
      document.getElementById('ruleEditorTitle').textContent = `✏️ Đang sửa: ${r.name}`;
      document.getElementById('ruleIdInput').value = r.id;
      document.getElementById('ruleNameInput').value = r.name;
      document.getElementById('ruleActionInput').value = r.action;
      document.getElementById('ruleMethodInput').value = r.method;
      document.getElementById('rulePatternInput').value = r.pathPattern;
      document.getElementById('ruleStatusInput').value = r.statusCode || 200;
      document.getElementById('ruleDelayInput').value = r.delayMs || 0;
      document.getElementById('ruleErrorRateInput').value = r.errorRate || 0;
      document.getElementById('ruleBodyInput').value = r.responseBody || '';
    });
  });

  wrap.querySelectorAll('button[data-del-rule]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/rules/${btn.dataset.delRule}`, { method: 'DELETE' });
      if (res.ok) {
        state.rules = res.rules;
        renderRulesList();
      }
    });
  });
}

function resetRuleForm() {
  document.getElementById('ruleEditorTitle').textContent = '✏️ Tạo Luật Endpoint / Mock Mới';
  document.getElementById('ruleIdInput').value = '';
  document.getElementById('ruleNameInput').value = '';
  document.getElementById('ruleActionInput').value = 'MOCK';
  document.getElementById('ruleMethodInput').value = 'GET';
  document.getElementById('rulePatternInput').value = '/api/custom-mock';
  document.getElementById('ruleStatusInput').value = 200;
  document.getElementById('ruleDelayInput').value = 0;
  document.getElementById('ruleErrorRateInput').value = 0;
  document.getElementById('ruleBodyInput').value = JSON.stringify(
    { ok: true, mockId: '{{uuid}}', timestamp: '{{isoDate}}', message: 'Phản hồi giả lập từ ChaosForge' },
    null,
    2
  );
}

function renderCassettesList() {
  document.getElementById('cassettesCountTab').textContent = state.cassettes.length;
  const wrap = document.getElementById('cassettesList');
  const activeId = state.config ? state.config.activeCassetteId : '';

  wrap.innerHTML = state.cassettes
    .map(
      (c) => `
      <div class="cassette-item ${c.id === activeId ? 'active' : ''}">
        <div style="cursor:pointer;flex:1;" data-open-cas="${c.id}">
          <div style="font-weight:700;">📼 ${escapeHtml(c.name)}</div>
          <div style="font-size:11.5px;color:var(--text-muted);">
            ID: <code>${escapeHtml(c.id)}</code> · <b>${c.entryCount}</b> bản ghi API
            ${c.id === activeId ? ' · <span class="text-green">ĐANG CHỌN</span>' : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-mini btn-accent" data-replay-cas="${c.id}">▶️ Phát Offline</button>
          ${c.id !== 'cas-demo-baseline' ? `<button class="btn-mini" data-del-cas="${c.id}">✕</button>` : ''}
        </div>
      </div>
    `
    )
    .join('');

  wrap.querySelectorAll('[data-open-cas]').forEach((el) => {
    el.addEventListener('click', () => loadCassetteDetail(el.dataset.openCas));
  });

  wrap.querySelectorAll('button[data-replay-cas]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const casId = btn.dataset.replayCas;
      await updateConfig({ activeCassetteId: casId, mode: 'OFFLINE_REPLAY', recording: false });
      await loadCassetteDetail(casId);
      showToast('📼 Đã bật chế độ PHÁT OFFLINE từ cuộn băng!', '#a855f7');
    });
  });

  wrap.querySelectorAll('button[data-del-cas]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await api(`/api/cassettes/${btn.dataset.delCas}`, { method: 'DELETE' });
      if (res.ok) {
        state.cassettes = res.cassettes;
        renderCassettesList();
      }
    });
  });
}

async function loadCassetteDetail(casId) {
  const res = await api(`/api/cassettes/${casId}`);
  if (!res.ok) return;
  state.activeCassetteDetail = res.cassette;
  state.selectedCassetteEntryId = null;
  document.getElementById('cassetteEntryEditor').classList.add('hidden');
  renderCassetteEntries();
}

function renderCassetteEntries() {
  const cas = state.activeCassetteDetail;
  const wrap = document.getElementById('cassetteEntriesWrap');
  if (!cas) {
    wrap.innerHTML = `<div class="empty-cell">Chọn một cuộn băng bên trái.</div>`;
    return;
  }

  document.getElementById('cassetteDetailTitle').textContent = `🎞️ ${cas.name} (${cas.entries.length} bản ghi)`;

  if (cas.entries.length === 0) {
    wrap.innerHTML = `<div class="empty-cell">Cuộn băng trống. Bấm <b>REC</b> hoặc <b>🌐 Nhập Chrome .HAR</b>!</div>`;
    return;
  }

  wrap.innerHTML = cas.entries
    .map(
      (e, i) => `
      <div class="cas-entry-row ${e.id === state.selectedCassetteEntryId ? 'active' : ''}">
        <div>
          <span class="text-muted">#${i + 1}</span>
          <span class="method-badge m-${e.method}">${e.method}</span>
          <code>${escapeHtml(e.fullPath)}</code>
        </div>
        <div>
          <span class="status-pill st-2xx">${e.statusCode}</span>
          <small class="text-muted">${e.originalMs || 0}ms</small>
          <button class="btn-mini" data-edit-entry="${e.id}">✏️ Sửa JSON</button>
        </div>
      </div>
    `
    )
    .join('');

  wrap.querySelectorAll('button[data-edit-entry]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = cas.entries.find((x) => x.id === btn.dataset.editEntry);
      if (!entry) return;
      state.selectedCassetteEntryId = entry.id;
      renderCassetteEntries();
      document.getElementById('cassetteEntryEditor').classList.remove('hidden');
      document.getElementById('casEntryEditHeader').textContent = `✏️ Sửa bản ghi [${entry.method} ${entry.fullPath}]`;
      document.getElementById('casEntryStatus').value = entry.statusCode || 200;
      document.getElementById('casEntryMs').value = entry.originalMs || 35;
      document.getElementById('casEntryBody').value = prettyJsonOrRaw(entry.resBody);
    });
  });
}

// ============================================================================
// 7. SUPERAPP v2 CRASH-TEST LAB (REST + AI SSE + WS + 401 MUTEX + GRAPHQL)
// ============================================================================

function logVictimConsole(msg, type = 'info') {
  const box = document.getElementById('victimConsole');
  const color = type === 'err' ? '#f87171' : type === 'ok' ? '#4ade80' : type === 'warn' ? '#fbbf24' : '#93c5fd';
  const line = document.createElement('div');
  line.className = 'vlog-line';
  line.style.color = color;
  line.textContent = `[${new Date().toLocaleTimeString('vi-VN', { hour12: false })}] ${msg}`;
  box.prepend(line);
}

function setVictimNotice(text, level = 'warn') {
  const el = document.getElementById('victimStatusNotice');
  if (!text) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = text;
  el.className = `victim-notice ${level}`;
  el.classList.remove('hidden');
}

function showVictimWhiteScreenCrash(err) {
  document.getElementById('victimAppBody').classList.add('hidden');
  const crash = document.getElementById('victimCrashScreen');
  crash.classList.remove('hidden');
  document.getElementById('victimCrashStack').textContent = `${err.name || 'Error'}: ${err.message}\n    at PayFlowFragileUI (victim-superapp.js:64:15)`;
}

function clearVictimCrash() {
  document.getElementById('victimCrashScreen').classList.add('hidden');
  document.getElementById('victimAppBody').classList.remove('hidden');
}

// Shared Refresh Token Mutex for Resilient Mode!
async function refreshAccessTokenWithMutex() {
  if (!state.refreshMutexPromise) {
    logVictimConsole(`🛡️ [Auth Mutex] Chỉ cử 1 request duy nhất gọi POST /auth/refresh cho cả nhóm 401...`, 'warn');
    state.refreshMutexPromise = fetch(`${getProxyBaseUrl()}/auth/refresh`, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        state.victimToken = d.accessToken || 'tok_refreshed';
        return state.victimToken;
      })
      .finally(() => {
        state.refreshMutexPromise = null;
      });
  }
  return state.refreshMutexPromise;
}

async function fetchResilientClient(path, opts = {}) {
  const { timeoutMs = 4200, maxRetries = 3, idempotencyKey = '', withAuth = false } = opts;
  const url = `${getProxyBaseUrl()}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  if (withAuth) headers['Authorization'] = `Bearer ${state.victimToken}`;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body,
        signal: controller.signal
      });
      clearTimeout(timer);

      // 401 Token Refresh with Shared Mutex!
      if (res.status === 401 && withAuth && attempt === 0) {
        const freshTok = await refreshAccessTokenWithMutex();
        headers['Authorization'] = `Bearer ${freshTok}`;
        continue;
      }

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        const retrySec = Number(res.headers.get('Retry-After')) || 0;
        const waitMs = retrySec > 0 ? Math.min(1000, retrySec * 450) : 260 * Math.pow(1.8, attempt);
        logVictimConsole(`🛡️ HTTP ${res.status} ở ${path} ➔ Retry #${attempt + 1} sau ${Math.round(waitMs)}ms`, 'warn');
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const rawText = await res.text();
      let parsed;
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        throw new Error(`MALFORMED_JSON_PAYLOAD (HTTP ${res.status})`);
      }

      if (!res.ok) throw new Error(parsed?.message || `HTTP_${res.status}`);
      return parsed;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === 'AbortError' ? new Error(`ABORTED_TIMEOUT_${timeoutMs}MS`) : err;
      if (attempt < maxRetries && !String(lastErr.message).includes('ABORTED_TIMEOUT')) {
        await new Promise((r) => setTimeout(r, 220 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// PROBE A: AI SSE Streaming (Fragile vs Resilient)
async function victimRunAiStream() {
  clearVictimCrash();
  const aiBox = document.getElementById('victimAiBox');
  aiBox.classList.remove('hidden');
  aiBox.innerHTML = `🤖 <b>AI Tư Vấn:</b> <span id="aiStreamText">⏳ Đang kết nối luồng SSE...</span>`;
  const textSpan = document.getElementById('aiStreamText');

  if (state.uiArmorMode === 'FRAGILE') {
    try {
      const res = await fetch(`${getProxyBaseUrl()}/ai/stream?prompt=Keychron`, {
        headers: { Accept: 'text/event-stream' }
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let output = '';
      let gotDone = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));
        for (const line of lines) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            gotDone = true;
            break;
          }
          // Crashes immediately if SSE_CORRUPT_FRAME injected malformed JSON!
          const obj = JSON.parse(payload);
          output += obj.delta;
          textSpan.textContent = output + ' ▍';
        }
      }
      if (!gotDone) {
        throw new Error('MID_STREAM_DROP: Luồng SSE bị đứt đột ngột trước khi nhận [DONE]!');
      }
      textSpan.textContent = output;
      logVictimConsole(`✓ [Fragile AI SSE] Hoàn tất stream.`, 'ok');
    } catch (err) {
      logVictimConsole(`💥 [Fragile AI SSE SẬP] ${err.message}`, 'err');
      showVictimWhiteScreenCrash(err);
    }
  } else {
    // 🛡️ RESILIENT SSE READER: Deduplicates id:, skips corrupt frames, handles mid-stream drop gracefully!
    const seenIds = new Set();
    let output = '';
    let skippedBadFrames = 0;
    let gotDone = false;

    try {
      const res = await fetch(`${getProxyBaseUrl()}/ai/stream?prompt=Keychron`, {
        headers: { Accept: 'text/event-stream' }
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          let frameId = null;
          let dataStr = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frameId = line.slice(4).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!dataStr) continue;
          if (dataStr === '[DONE]') {
            gotDone = true;
            break;
          }
          if (frameId && seenIds.has(frameId)) {
            logVictimConsole(`🛡️ [SSE Guard] Đã khử 1 chunk bị nhân đôi (id=${frameId})`, 'warn');
            continue;
          }
          try {
            const obj = JSON.parse(dataStr);
            if (frameId) seenIds.add(frameId);
            output += String(obj.delta || '');
            textSpan.textContent = output + ' ▍';
          } catch {
            skippedBadFrames++;
            logVictimConsole(`🛡️ [SSE Guard] Bỏ qua 1 frame SSE hỏng cú pháp JSON!`, 'warn');
          }
        }
      }
    } catch (err) {
      logVictimConsole(`🛡️ [SSE Guard] Phát hiện đứt mạng giữa chừng: ${err.message}`, 'warn');
    }

    if (!gotDone) {
      textSpan.textContent = (output || '(Luồng gián đoạn sớm)') + ' [⚡ Đã lưu phần văn bản nhận được trước khi đứt cáp]';
      setVictimNotice(`🛡️ Luồng AI bị đứt giữa chừng (hoặc có ${skippedBadFrames} frame lỗi) nhưng UI đã bảo toàn nội dung không bị treo!`, 'warn');
    } else {
      textSpan.textContent = output;
      if (skippedBadFrames > 0) {
        setVictimNotice(`🛡️ Đã lọc bỏ ${skippedBadFrames} frame SSE hỏng cú pháp và hoàn thành câu trả lời!`, 'warn');
      }
    }
  }
}

// PROBE B: WebSocket Live Ticker & Auto-Reconnect
function victimToggleWebSocket() {
  const wsLine = document.getElementById('vwWsTickerLine');
  const btn = document.getElementById('btnProbeWsToggle');

  if (state.victimWsWanted) {
    state.victimWsWanted = false;
    if (state.victimWsReconnectTimer) clearTimeout(state.victimWsReconnectTimer);
    if (state.victimWs) state.victimWs.close();
    state.victimWs = null;
    btn.textContent = '📡 Kết Nối Ticker (WebSocket)';
    wsLine.textContent = '📡 WebSocket Ticker: Đã ngắt chủ động';
    return;
  }

  state.victimWsWanted = true;
  btn.textContent = '⏹ Tắt WebSocket Ticker';
  let reconnectAttempt = 0;

  const connectNow = () => {
    if (!state.victimWsWanted) return;
    wsLine.textContent = '📡 WebSocket: Đang bắt tay tới ws://localhost:4191/ws...';
    const ws = new WebSocket(`${getProxyWsUrl()}/ws`);
    state.victimWs = ws;

    ws.onopen = () => {
      reconnectAttempt = 0;
      wsLine.textContent = '🟢 WebSocket Đang Mở — Đang nhận nhịp giá VN30...';
      logVictimConsole(`🟢 Đã mở kết nối WebSocket qua Proxy :4191`, 'ok');
    };

    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'ticker') {
          wsLine.textContent = `🟢 WS Live #${d.seq}: VN30 = ${d.vn30} · Online: ${d.activeUsers} người`;
        }
      } catch {}
    };

    ws.onclose = () => {
      if (!state.victimWsWanted) return;
      if (state.uiArmorMode === 'FRAGILE') {
        wsLine.textContent = '🔴 MẤT KẾT NỐI WEBSOCKET! (Code Ngây Thơ chết đứng không tự nối lại)';
        logVictimConsole(`💥 [Fragile WS] Socket bị cắt ➔ Không có Auto-Reconnect!`, 'err');
        state.victimWsWanted = false;
        btn.textContent = '📡 Kết Nối Ticker (WebSocket)';
      } else {
        reconnectAttempt++;
        const backoff = Math.min(4000, 750 * reconnectAttempt);
        wsLine.textContent = `🟡 WS bị cắt! 🛡️ Đang tự động nối lại sau ${backoff}ms (Lần #${reconnectAttempt})...`;
        logVictimConsole(`🛡️ [Resilient WS] Tự động Auto-Reconnect sau ${backoff}ms...`, 'warn');
        state.victimWsReconnectTimer = setTimeout(connectNow, backoff);
      }
    };
  };

  connectNow();
}

// PROBE C: 401 Auth Parallel Burst Test (Fragile Race vs Resilient Mutex)
async function victimTestAuth401Burst() {
  clearVictimCrash();
  const trackBox = document.getElementById('victimTrackBox');
  trackBox.classList.remove('hidden');

  // Arm 401 expiration on Proxy first
  const beforeState = await api('/api/state');
  const prevRaces = beforeState.telemetry?.authRaceIncidents || 0;
  await api('/api/auth-chaos/expire-now', { method: 'POST' });

  const slots = [1, 2, 3, 4];

  if (state.uiArmorMode === 'FRAGILE') {
    logVictimConsole(`❌ [Fragile 401] Bắn 4 API song song khi Token hết hạn (Không có Refresh Mutex)...`);
    const naiveCall = async (slot) => {
      let r = await fetch(`${getProxyBaseUrl()}/protected/widget?slot=${slot}`, {
        headers: { Authorization: `Bearer ${state.victimToken}` }
      });
      if (r.status === 401) {
        // BUG: Every failing parallel call fires its own /auth/refresh!
        const refRes = await fetch(`${getProxyBaseUrl()}/auth/refresh`, { method: 'POST' });
        const refData = await refRes.json();
        state.victimToken = refData.accessToken;
        r = await fetch(`${getProxyBaseUrl()}/protected/widget?slot=${slot}`, {
          headers: { Authorization: `Bearer ${state.victimToken}` }
        });
      }
      return r.json();
    };

    await Promise.all(slots.map(naiveCall));
    const afterState = await api('/api/state');
    const newRaces = (afterState.telemetry?.authRaceIncidents || 0) - prevRaces;
    trackBox.innerHTML = `🚨 <b>BẪY 401 PHÁT NỔ:</b> Cả 4 request cùng tự gọi <code>POST /auth/refresh</code> song song gây ra <b>${newRaces} xung đột Refresh Race</b> (Thực tế sẽ bị thu hồi Refresh Token &amp; văng đăng nhập)!`;
    setVictimNotice('💥 Dính lỗi 401 Refresh Token Race Condition!', 'err');
    return { ok: false, raceTriggered: newRaces > 0 };
  } else {
    logVictimConsole(`🛡️ [Resilient 401] Bắn 4 API song song với Shared Refresh Promise Mutex...`);
    const results = await Promise.all(
      slots.map((slot) => fetchResilientClient(`/protected/widget?slot=${slot}`, { withAuth: true, maxRetries: 2 }))
    );
    const afterState = await api('/api/state');
    const newRaces = (afterState.telemetry?.authRaceIncidents || 0) - prevRaces;
    trackBox.innerHTML = `🛡️ <b>AUTH MUTEX THÀNH CÔNG:</b> Tải xong ${results.length}/4 widget bảo mật chỉ với <b>ĐÚNG 1 LẦN</b> gọi <code>/auth/refresh</code> (0 xung đột Race)!`;
    setVictimNotice('🛡️ Refresh Token Mutex đã gom 4 lỗi 401 thành 1 lần làm mới duy nhất!', 'ok');
    return { ok: newRaces === 0, raceTriggered: newRaces > 0 };
  }
}

// PROBE D: GraphQL Query Test (Partial Data + Errors)
async function victimTestGraphql() {
  clearVictimCrash();
  const trackBox = document.getElementById('victimTrackBox');
  trackBox.classList.remove('hidden');

  const gqlPayload = JSON.stringify({
    operationName: 'GetWalletDashboard',
    query: 'query GetWalletDashboard { wallet { owner balance } featuredProducts { id name price } }'
  });

  if (state.uiArmorMode === 'FRAGILE') {
    try {
      const res = await fetch(`${getProxyBaseUrl()}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: gqlPayload
      });
      const json = await res.json();
      // Crashes if data or data.wallet was nulled by Partial GraphQL Chaos!
      const bal = json.data.wallet.balance.toLocaleString('vi-VN');
      trackBox.innerHTML = `🕸️ <b>GraphQL GetWalletDashboard:</b> Số dư ${bal} ₫ · ${json.data.featuredProducts.length} sản phẩm`;
      logVictimConsole(`✓ [Fragile GQL] Thành công.`, 'ok');
    } catch (err) {
      logVictimConsole(`💥 [Fragile GQL SẬP] ${err.message}`, 'err');
      showVictimWhiteScreenCrash(err);
    }
  } else {
    try {
      const json = await fetchResilientClient('/graphql', { method: 'POST', body: gqlPayload });
      const errs = Array.isArray(json?.errors) ? json.errors.map((e) => e.message).join('; ') : '';
      const bal =
        typeof json?.data?.wallet?.balance === 'number'
          ? formatMoneyVnd(json.data.wallet.balance)
          : '(Đang tạm ẩn do lỗi dịch vụ phụ)';
      const count = Array.isArray(json?.data?.featuredProducts) ? json.data.featuredProducts.length : 0;

      trackBox.innerHTML = `🕸️ <b>GraphQL An Toàn:</b> Ví: <b>${bal}</b> · Sản phẩm khả dụng: <b>${count}</b> ${
        errs ? `<br><small class="text-warning">⚠️ Cảnh báo GraphQL errors[]: ${escapeHtml(errs)}</small>` : ''
      }`;
      if (errs) setVictimNotice(`🛡️ Phát hiện GraphQL Partial Error trong HTTP 200 OK — Đã hiển thị phần dữ liệu còn sống!`, 'warn');
      else setVictimNotice(`🛡️ Truy vấn GraphQL hợp lệ 100%.`, 'ok');
    } catch (err) {
      setVictimNotice(`🛡️ GraphQL lỗi mạng đã được xử lý êm: ${err.message}`, 'warn');
    }
  }
}

// REST Store Load & Checkout
async function victimLoadStoreData(customTimeoutMs) {
  clearVictimCrash();
  setVictimNotice('');
  const proxyUrl = getProxyBaseUrl();

  if (state.uiArmorMode === 'FRAGILE') {
    try {
      const [sumRes, prodRes] = await Promise.all([fetch(`${proxyUrl}/dashboard/summary`), fetch(`${proxyUrl}/products`)]);
      if (!sumRes.ok) throw new Error(`HTTP ${sumRes.status} Summary`);
      if (!prodRes.ok) throw new Error(`HTTP ${prodRes.status} Products`);

      const summary = await sumRes.json();
      const prodData = await prodRes.json();

      document.getElementById('vwUserName').textContent = `${summary.user.avatar} ${summary.user.name} (${summary.user.tier})`;
      document.getElementById('vwSourceInfo').textContent = summary.source;
      document.getElementById('vwBalance').textContent = summary.wallet.balance.toLocaleString('vi-VN') + ' ₫';

      document.getElementById('victimProductsGrid').innerHTML = prodData.products
        .map(
          (p) => `
          <div class="prod-card">
            <span class="prod-badge">${escapeHtml(String(p.badge))}</span>
            <div class="prod-name">${escapeHtml(String(p.name))}</div>
            <div class="prod-meta"><span>${p.price.toLocaleString('vi-VN')} ₫</span><span>Kho: ${p.stock}</span></div>
          </div>
        `
        )
        .join('');
      return { ok: true, crashed: false };
    } catch (err) {
      logVictimConsole(`💥 [Fragile SẬP TRANG] ${err.name}: ${err.message}`, 'err');
      showVictimWhiteScreenCrash(err);
      return { ok: false, crashed: true, error: err.message };
    }
  } else {
    let degradedReasons = [];
    let summary = null;
    let prodData = null;

    try {
      summary = await fetchResilientClient('/dashboard/summary', { timeoutMs: customTimeoutMs || 4200, maxRetries: 2 });
      if (summary && typeof summary === 'object') state.lastKnownGoodSummary = summary;
    } catch (err) {
      degradedReasons.push(`Ví (${err.message})`);
      summary = state.lastKnownGoodSummary;
    }

    try {
      prodData = await fetchResilientClient('/products', { timeoutMs: customTimeoutMs || 4200, maxRetries: 2 });
      if (prodData && Array.isArray(prodData.products)) state.lastKnownGoodProducts = prodData;
    } catch (err) {
      degradedReasons.push(`Sản phẩm (${err.message})`);
      prodData = state.lastKnownGoodProducts;
    }

    const safeName = String(summary?.user?.name || 'Khách hàng (An toàn)').slice(0, 80);
    const safeTier = String(summary?.user?.tier || 'MEMBER').slice(0, 24);
    const rawBal = summary?.wallet?.balance;
    const safeBal = typeof rawBal === 'number' && Number.isFinite(rawBal) && rawBal >= 0 ? rawBal : 0;

    document.getElementById('vwUserName').textContent = `🧑‍💻 ${safeName} (${safeTier})`;
    document.getElementById('vwSourceInfo').textContent = String(summary?.source || 'Safe Fallback').slice(0, 90);
    document.getElementById('vwBalance').textContent = formatMoneyVnd(safeBal);

    const rawList = prodData?.products;
    const grid = document.getElementById('victimProductsGrid');

    if (!Array.isArray(rawList)) {
      degradedReasons.push('products=null ➔ Empty Fallback');
      grid.innerHTML = `<div class="empty-cell" style="grid-column:1/-1;">🛡️ Dữ liệu danh sách không hợp lệ (<code>null</code>) — UI vẫn an toàn không sập!</div>`;
    } else if (rawList.length === 0) {
      grid.innerHTML = `<div class="empty-cell" style="grid-column:1/-1;">📭 Hiện chưa có sản phẩm Flash Sale nào.</div>`;
    } else {
      grid.innerHTML = rawList
        .map((p) => {
          const priceNum = typeof p?.price === 'number' && p.price >= 0 ? p.price : 0;
          const stockNum = typeof p?.stock === 'number' && p.stock >= 0 ? p.stock : 0;
          return `
            <div class="prod-card resilient-clamp">
              <span class="prod-badge">${escapeHtml(String(p?.badge || 'SALE').slice(0, 24))}</span>
              <div class="prod-name">${escapeHtml(String(p?.name || 'Sản phẩm'))}</div>
              <div class="prod-meta"><span>${priceNum > 0 ? formatMoneyVnd(priceNum) : 'Liên hệ'}</span><span>Kho: ${stockNum}</span></div>
            </div>
          `;
        })
        .join('');
    }

    if (degradedReasons.length > 0) {
      setVictimNotice(`🛡️ Lá chắn Resilient UI đã hấp thụ sự cố: ${degradedReasons.join(' | ')}`, 'warn');
    } else {
      setVictimNotice('🛡️ Dữ liệu đã xác thực Schema & hiển thị an toàn.', 'ok');
    }
    return { ok: true, crashed: false, degradedReasons };
  }
}

async function victimTriggerCheckout(sharedIdemKey = '') {
  const proxyUrl = getProxyBaseUrl();
  const btn = document.getElementById('btnVictimCheckout');

  if (state.uiArmorMode === 'FRAGILE') {
    try {
      const res = await fetch(`${proxyUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemName: 'Keychron Q1 Pro Wireless', amount: 4290000 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      document.getElementById('vwBalance').textContent = formatMoneyVnd(data.walletBalance);
      if (data.duplicateWarning) {
        setVictimNotice(`💥 ${data.duplicateWarning}`, 'err');
        return { ok: false, doubleCharged: true };
      }
      setVictimNotice(`✅ Đã trừ ví 4.290.000 ₫ — Mã đơn: ${data.order.orderId}`, 'ok');
      return { ok: true, doubleCharged: false };
    } catch (err) {
      setVictimNotice(`💥 Lỗi thanh toán: ${err.message}`, 'err');
      return { ok: false, error: err.message };
    }
  } else {
    if (state.checkoutInFlight) {
      return { ok: true, blockedDuplicateClick: true };
    }
    state.checkoutInFlight = true;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '⏳ Đang xử lý an toàn...';
    const idemKey = sharedIdemKey || 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    try {
      const data = await fetchResilientClient('/checkout', {
        method: 'POST',
        idempotencyKey: idemKey,
        timeoutMs: 5000,
        maxRetries: 3,
        body: JSON.stringify({ itemName: 'Keychron Q1 Pro Wireless', amount: 4290000 })
      });
      if (typeof data?.walletBalance === 'number') {
        document.getElementById('vwBalance').textContent = formatMoneyVnd(data.walletBalance);
      }
      setVictimNotice(`🛡️ ${data.message}`, 'ok');
      return { ok: true, doubleCharged: false };
    } catch (err) {
      setVictimNotice(`🛡️ Đã hủy giao dịch an toàn (${err.message})`, 'warn');
      return { ok: false, safeHandled: true };
    } finally {
      state.checkoutInFlight = false;
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

// Automated 7-Vector Resilience Benchmark (v2.0)
async function runAutomatedBenchmark() {
  const btn = document.getElementById('btnRunBenchmark');
  btn.disabled = true;
  btn.textContent = '⏳ Đang sát hạch 7 bài...';

  const listEl = document.getElementById('benchResultsList');
  listEl.innerHTML = '';
  const savedConfig = JSON.parse(JSON.stringify(state.config));
  await api('/api/demo/reset', { method: 'POST' });
  state.lastKnownGoodSummary = null;
  state.lastKnownGoodProducts = null;

  const results = [];
  const pushResult = (title, passed, pts, detail) => {
    results.push({ title, passed, pts: passed ? pts : 0, maxPts: pts, detail });
    listEl.innerHTML = results
      .map(
        (r) => `
        <div class="bench-row">
          <div>
            <strong>${r.passed ? '✅' : '❌'} ${escapeHtml(r.title)}</strong>
            <div style="color:var(--text-muted);font-size:11px;">${escapeHtml(r.detail)}</div>
          </div>
          <code style="color:${r.passed ? '#4ade80' : '#f87171'};font-weight:700;">+${r.pts}/${r.maxPts}</code>
        </div>
      `
      )
      .join('');
  };

  try {
    await updateConfig({ breakpoints: { interceptRequest: false, interceptResponse: false }, authChaos: { enabled: false } });

    // 1. Clean Baseline (10 pts)
    await api('/api/preset', { method: 'POST', body: JSON.stringify({ presetId: 'clean' }) });
    const r1 = await victimLoadStoreData();
    pushResult('1. Mạng chuẩn Baseline (0ms)', r1.ok && !r1.crashed, 10, 'Kết nối & render chuẩn');

    // 2. 75% HTTP 429 Storm (15 pts)
    await updateConfig({
      mode: 'CHAOS',
      chaos: { latencyMs: 30, jitterMs: 20, spikeRate: 0, errorRate: 75, errorCodes: [429], dropRate: 0, hangRate: 0, throttleKbps: 0 },
      mutator: { enabled: false }
    });
    const r2a = await victimLoadStoreData();
    const r2b = r2a.ok ? await victimLoadStoreData() : r2a;
    pushResult('2. Bão quá tải 75% HTTP 429', !r2b.crashed && r2b.ok, 15, !r2b.crashed && r2b.ok ? 'Exponential Backoff thành công' : 'Thiếu cơ chế Retry');

    // 3. Nullify JSON (15 pts)
    await updateConfig({
      mode: 'CHAOS',
      chaos: { latencyMs: 15, errorRate: 0, dropRate: 0, hangRate: 0 },
      mutator: { enabled: true, mutationRate: 100, nullifyFields: true, targetKeys: 'products, wallet', truncateJson: false }
    });
    const r3 = await victimLoadStoreData();
    pushResult('3. Bẫy Nullify JSON (products = null)', !r3.crashed, 15, !r3.crashed ? 'Schema Fallback an toàn' : 'Nổ lỗi TypeError null.map');

    // 4. Truncated Malformed JSON (15 pts)
    await updateConfig({ mutator: { enabled: true, nullifyFields: false, truncateJson: true } });
    const r4 = await victimLoadStoreData();
    pushResult('4. Cắt cụt JSON giữa chừng (Malformed)', !r4.crashed, 15, !r4.crashed ? 'Bắt gọn SyntaxError' : 'Trắng trang vì res.json()');

    // 5. Hang Timeout AbortController (15 pts)
    await updateConfig({
      mode: 'CHAOS',
      chaos: { latencyMs: 0, errorRate: 0, dropRate: 0, hangRate: 100, hangMs: 4500 },
      mutator: { enabled: false, truncateJson: false }
    });
    const t5Start = performance.now();
    const raceWinner = await Promise.race([
      victimLoadStoreData(1050).then((res) => ({ finished: true, res })),
      new Promise((resolve) => setTimeout(() => resolve({ finished: false }), 1850))
    ]);
    const t5Elapsed = Math.round(performance.now() - t5Start);
    const passedTimeout = raceWinner.finished && !raceWinner.res.crashed && t5Elapsed < 1800;
    pushResult('5. Chống treo vô tận (AbortController)', passedTimeout, 15, passedTimeout ? `Tự cắt sau ${t5Elapsed}ms` : 'Treo cứng giao diện');

    // 6. Double-Click Checkout under Latency (15 pts)
    await api('/api/demo/reset', { method: 'POST' });
    await updateConfig({ mode: 'CHAOS', chaos: { latencyMs: 800, jitterMs: 40, errorRate: 0, hangRate: 0 }, mutator: { enabled: false } });
    const click1 = victimTriggerCheckout();
    await new Promise((r) => setTimeout(r, 110));
    const click2 = victimTriggerCheckout();
    const [c1, c2] = await Promise.all([click1, click2]);
    const noDoubleCharge = !c1.doubleCharged && !c2.doubleCharged && c1.ok;
    pushResult('6. Chống trừ tiền đúp (Idempotency)', noDoubleCharge, 15, noDoubleCharge ? 'Bảo toàn số dư ví' : 'Trừ tiền 2 lần khi bấm đúp');

    // 7. 401 Auth Refresh Race-Condition (15 pts)
    await updateConfig({ mode: 'PASSTHROUGH', chaos: { latencyMs: 0, errorRate: 0, hangRate: 0 } });
    const r7 = await victimTestAuth401Burst();
    pushResult('7. Chống bão Refresh 401 Song Song (Mutex)', r7.ok && !r7.raceTriggered, 15, r7.ok ? '4 API cùng 401 nhưng chỉ gọi Refresh 1 lần' : 'Gọi /auth/refresh 4 lần chồng chéo!');

    const totalScore = results.reduce((s, x) => s + x.pts, 0);
    const circle = document.getElementById('benchScoreCircle');
    circle.textContent = `${totalScore}`;
    circle.style.borderColor = totalScore >= 85 ? '#22c55e' : totalScore >= 50 ? '#f59e0b' : '#ef4444';
    circle.style.color = totalScore >= 85 ? '#4ade80' : totalScore >= 50 ? '#fbbf24' : '#f87171';

    document.getElementById('benchVerdictTitle').textContent =
      totalScore >= 85
        ? `🏆 ĐẠT CHUẨN BỌC THÉP (${totalScore}/100) — Miễn Nhiễm Cả 7 Cơn Bão API!`
        : `🚨 CẢNH BÁO ĐỎ (${totalScore}/100) — Giao Diện Dễ Sập, Mất Tiền & Văng Auth!`;
    document.getElementById('benchVerdictSub').textContent =
      totalScore >= 85
        ? 'Sang Tab 💉 Floating HUD & Ghép Nối để copy trọn bộ fetchResilient + AuthRefreshMutex!'
        : 'Hãy chuyển sang [🛡️ Code Phòng Thủ] ở góc phải phía trên rồi chạy lại để đối chứng!';
  } finally {
    await updateConfig(savedConfig);
    btn.disabled = false;
    btn.textContent = '🚀 Chạy Sát Hạch Tự Động';
  }
}

// ============================================================================
// 8. STATIC EVENT BINDINGS
// ============================================================================

async function updateConfig(partial) {
  const res = await api('/api/config', { method: 'POST', body: JSON.stringify(partial) });
  if (res.ok) {
    state.config = res.config;
    renderConfigControls();
  }
  return res;
}

function bindStaticEvents() {
  // Workspace Tabs
  document.querySelectorAll('.workspace-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.workspace-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'timeline') {
        refreshMarkdownReport();
        harvestOpenApiNow();
      }
    });
  });

  // Inspector Sub-tabs
  document.querySelectorAll('#inspectorSubTabs .sub-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#inspectorSubTabs .sub-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.inspector-panel .sub-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`sub-${btn.dataset.sub}`).classList.add('active');
    });
  });

  document.getElementById('btnCopyProxyUrl').addEventListener('click', () => {
    navigator.clipboard.writeText(getProxyBaseUrl());
    showToast(`Đã copy Proxy Gateway: ${getProxyBaseUrl()}`);
  });

  document.getElementById('selectQuickTarget').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('inputTargetUrl').value = e.target.value;
  });

  document.getElementById('btnSaveTarget').addEventListener('click', async () => {
    const url = document.getElementById('inputTargetUrl').value.trim();
    if (!url) return;
    await updateConfig({ targetUrl: url });
    showToast(`🎯 Đã trỏ Upstream về: ${url}`);
  });

  document.querySelectorAll('#modeSwitch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await updateConfig({ mode: btn.dataset.mode });
      showToast(`Chế độ Proxy: ${btn.textContent.trim()}`);
    });
  });

  document.getElementById('btnToggleRecord').addEventListener('click', async () => {
    const next = !(state.config && state.config.recording);
    await updateConfig({ recording: next });
    showToast(next ? `🔴 ĐANG GHI BĂNG vào '${state.config.activeCassetteId}'` : '⏹ Đã dừng ghi băng.', next ? '#ef4444' : '#38bdf8');
  });

  document.getElementById('btnQuickBreakpoint').addEventListener('click', async () => {
    const cur = Boolean(state.config?.breakpoints?.interceptResponse);
    await updateConfig({ breakpoints: { interceptResponse: !cur } });
    showToast(!cur ? '⏸ Đã BẬT Bắt Sống Gói Tin Response!' : '▶️ Đã tắt Bắt sống gói tin.', '#f59e0b');
  });

  document.getElementById('btnResetClean').addEventListener('click', async () => {
    await api('/api/preset', { method: 'POST', body: JSON.stringify({ presetId: 'clean' }) });
    showToast('🟢 Đã đặt lại đường truyền sạch 0ms.');
  });

  // Sliders
  const sliderMappings = [
    ['rngLatencyMs', 'valLatencyMs', 'latencyMs', (v) => `${v} ms`],
    ['rngJitterMs', 'valJitterMs', 'jitterMs', (v) => `${v} ms`],
    ['rngSpikeRate', 'valSpikeRate', 'spikeRate', (v) => `${v}%`],
    ['rngErrorRate', 'valErrorRate', 'errorRate', (v) => `${v}%`],
    ['rngDropRate', 'valDropRate', 'dropRate', (v) => `${v}%`],
    ['rngHangRate', 'valHangRate', 'hangRate', (v) => `${v}%`],
    ['rngThrottleKbps', 'valThrottleKbps', 'throttleKbps', (v) => (v > 0 ? `${v} KB/s` : 'Không giới hạn')],
    ['rngStripCorsRate', 'valStripCorsRate', 'stripCorsRate', (v) => `${v}%`]
  ];

  for (const [id, labelId, key, fmt] of sliderMappings) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      document.getElementById(labelId).textContent = fmt(Number(el.value));
    });
    el.addEventListener('change', () => {
      updateConfig({ mode: 'CHAOS', activePreset: 'custom', chaos: { [key]: Number(el.value) } });
    });
  }

  document.getElementById('chkCorsBypass').addEventListener('change', (e) => updateConfig({ corsBypass: e.target.checked }));

  document.querySelectorAll('#errorCodeChips input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const codes = Array.from(document.querySelectorAll('#errorCodeChips input:checked')).map((x) => Number(x.value));
      updateConfig({ chaos: { errorCodes: codes.length ? codes : [500] } });
    });
  });

  // JSON Mutator
  const syncMutator = () => {
    updateConfig({
      mode: 'CHAOS',
      activePreset: 'custom',
      mutator: {
        enabled: document.getElementById('chkMutatorEnabled').checked,
        nullifyFields: document.getElementById('chkMutNullify').checked,
        emptyArrays: document.getElementById('chkMutEmptyArr').checked,
        overflowStrings: document.getElementById('chkMutOverflow').checked,
        typeConfusion: document.getElementById('chkMutTypeConfuse').checked,
        truncateJson: document.getElementById('chkMutTruncate').checked,
        htmlInsteadOfJson: document.getElementById('chkMutHtml').checked,
        targetKeys: document.getElementById('inpMutTargetKeys').value,
        jsonOverrides: document.getElementById('inpJsonOverrides').value
      }
    });
  };

  ['chkMutatorEnabled', 'chkMutNullify', 'chkMutEmptyArr', 'chkMutOverflow', 'chkMutTypeConfuse', 'chkMutTruncate', 'chkMutHtml'].forEach((id) => {
    document.getElementById(id).addEventListener('change', (e) => {
      if (id !== 'chkMutatorEnabled' && e.target.checked) document.getElementById('chkMutatorEnabled').checked = true;
      syncMutator();
    });
  });
  document.getElementById('inpMutTargetKeys').addEventListener('change', syncMutator);
  document.getElementById('inpJsonOverrides').addEventListener('change', syncMutator);

  document.getElementById('btnSampleOverride').addEventListener('click', () => {
    document.getElementById('inpJsonOverrides').value = '{"wallet.balance": 0, "user.tier": "SUSPENDED"}';
    document.getElementById('chkMutatorEnabled').checked = true;
    syncMutator();
    showToast('🧬 Đã bật ghi đè JSON: wallet.balance = 0');
  });

  // v2.0 Stream & WebSocket Chaos Controls
  const syncStreamWs = () => {
    updateConfig({
      mode: 'CHAOS',
      streamChaos: {
        enabled: document.getElementById('chkStreamChaos').checked,
        tokenDelayMs: Number(document.getElementById('inpStreamTokenDelay').value) || 0,
        stallMidStreamMs: Number(document.getElementById('inpStreamStallMs').value) || 0,
        dropMidStreamRate: Number(document.getElementById('inpStreamDropRate').value) || 0,
        corruptEventRate: Number(document.getElementById('inpStreamCorruptRate').value) || 0
      },
      wsChaos: {
        enabled: document.getElementById('chkWsChaos').checked,
        frameDelayMs: Number(document.getElementById('inpWsDelayMs').value) || 0,
        autoDropAfterSec: Number(document.getElementById('inpWsAutoDropSec').value) || 0
      }
    });
  };
  ['chkStreamChaos', 'inpStreamTokenDelay', 'inpStreamStallMs', 'inpStreamDropRate', 'inpStreamCorruptRate', 'chkWsChaos', 'inpWsDelayMs', 'inpWsAutoDropSec'].forEach((id) => {
    document.getElementById(id).addEventListener('change', syncStreamWs);
  });

  document.getElementById('btnKillAllWs').addEventListener('click', async () => {
    const res = await api('/api/ws/kill-all', { method: 'POST' });
    showToast(`🔌 Đã cắt đứt ${res.killed || 0} kết nối WebSocket đang mở!`, '#ef4444');
  });

  // v2.0 Auth 401 & GraphQL Chaos Controls
  document.getElementById('btnExpireAuthNow').addEventListener('click', async () => {
    await api('/api/auth-chaos/expire-now', { method: 'POST' });
    showToast('🔐 Đã kích nổ bẫy 401! Mọi request có Token tiếp theo sẽ nhận 401 cho tới khi gọi /auth/refresh.', '#f59e0b');
  });

  const syncGql = () => {
    updateConfig({
      mode: 'CHAOS',
      graphqlChaos: {
        enabled: document.getElementById('chkGqlChaos').checked,
        targetOperations: document.getElementById('inpGqlTargets').value || '*',
        errors200Rate: Number(document.getElementById('inpGqlErrorsRate').value) || 0,
        partialDataRate: Number(document.getElementById('inpGqlPartialRate').value) || 0
      }
    });
  };
  ['chkGqlChaos', 'inpGqlTargets', 'inpGqlErrorsRate', 'inpGqlPartialRate'].forEach((id) => {
    document.getElementById(id).addEventListener('change', syncGql);
  });

  // Breakpoint Strip & Surgeon
  const syncBp = () => {
    updateConfig({
      breakpoints: {
        interceptResponse: document.getElementById('chkBpRes').checked,
        interceptRequest: document.getElementById('chkBpReq').checked,
        filterPattern: document.getElementById('inpBpPattern').value || '*'
      }
    });
  };
  document.getElementById('chkBpRes').addEventListener('change', syncBp);
  document.getElementById('chkBpReq').addEventListener('change', syncBp);
  document.getElementById('inpBpPattern').addEventListener('change', syncBp);

  document.getElementById('bpBodyEditor').addEventListener('input', validateBpJson);
  document.getElementById('btnBpResume').addEventListener('click', () => {
    const bp = state.breakpoints[0];
    if (bp && bp.phase === 'request' && Number(document.getElementById('bpStatusInput').value) >= 400) {
      resolveCurrentBreakpoint('short_circuit');
    } else {
      resolveCurrentBreakpoint('resume');
    }
  });
  document.getElementById('btnBpDrop').addEventListener('click', () => resolveCurrentBreakpoint('drop'));

  document.querySelectorAll('[data-bp-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const editor = document.getElementById('bpBodyEditor');
      const statusInp = document.getElementById('bpStatusInput');
      const kind = btn.dataset.bpPreset;
      if (kind === 'restore_orig') {
        statusInp.value = 200;
        editor.value = prettyJsonOrRaw(editor.dataset.origBody || '{}');
      } else if (kind === 'err_500') {
        statusInp.value = 500;
        editor.value = JSON.stringify({ ok: false, error: 'LIVE_INJECTED_500', message: 'Sập Database do Phẫu thuật viên tiêm!' }, null, 2);
      } else if (kind === 'err_429') {
        statusInp.value = 429;
        editor.value = JSON.stringify({ ok: false, error: 'RATE_LIMITED', message: '429 Quá tải!' }, null, 2);
      } else if (kind === 'truncate_json') {
        editor.value = editor.value.slice(0, Math.max(10, Math.floor(editor.value.length * 0.55))) + ' /* ✂️ CUT';
      } else if (kind === 'null_arrays') {
        try {
          const obj = JSON.parse(editor.value);
          for (const k of Object.keys(obj)) {
            if (Array.isArray(obj[k]) || (obj[k] && typeof obj[k] === 'object')) obj[k] = null;
          }
          editor.value = JSON.stringify(obj, null, 2);
        } catch {}
      } else if (kind === 'negative_money') {
        editor.value = editor.value.replace(/"(price|balance|amount|chargedAmount)"\s*:\s*\d+/g, '"$1": -999999999');
      }
      validateBpJson();
    });
  });

  // Traffic Toolbar & .HAR Export
  document.getElementById('inpTrafficFilter').addEventListener('input', renderTrafficTable);
  document.getElementById('selTrafficFilterType').addEventListener('change', renderTrafficTable);

  document.getElementById('btnFireProbe').addEventListener('click', async () => {
    const routes = ['/products', '/dashboard/summary', '/feature-flags', '/orders/track'];
    const pick = routes[Math.floor(Math.random() * routes.length)];
    try {
      await fetch(`${getProxyBaseUrl()}${pick}`);
      showToast(`⚡ Đã bắn gói thử GET ${pick} qua Proxy :4191`);
    } catch (err) {
      showToast(`⚡ Đã bắn GET ${pick} (${err.message})`, '#f59e0b');
    }
  });

  document.getElementById('btnExportTrafficHar').addEventListener('click', async () => {
    const har = await api('/api/har/export?source=traffic');
    downloadBlob(JSON.stringify(har, null, 2), `chaosforge-traffic-${Date.now()}.har`, 'application/json');
    showToast('📤 Đã xuất luồng lưu lượng ra tệp chuẩn Chrome .HAR!');
  });

  document.getElementById('btnClearTraffic').addEventListener('click', () => api('/api/traffic', { method: 'DELETE' }));

  document.getElementById('btnReplaySelected').addEventListener('click', async () => {
    const tx = state.traffic.find((t) => t.id === state.selectedTxId);
    if (!tx) return;
    await api('/api/replay-request', {
      method: 'POST',
      body: JSON.stringify({ method: tx.method, fullPath: tx.fullPath, headers: tx.reqHeaders, reqBody: tx.reqBody })
    });
    showToast(`🔁 Đã phát lại [${tx.method} ${tx.fullPath}]!`);
  });

  document.getElementById('btnCreateRuleFromTx').addEventListener('click', () => {
    const tx = state.traffic.find((t) => t.id === state.selectedTxId);
    if (!tx) return;
    document.querySelector('.workspace-tabs [data-tab="rules"]').click();
    document.getElementById('ruleIdInput').value = '';
    document.getElementById('ruleNameInput').value = `Mock từ gói ${tx.method} ${tx.path}`;
    document.getElementById('ruleActionInput').value = 'MOCK';
    document.getElementById('ruleMethodInput').value = tx.method;
    document.getElementById('rulePatternInput').value = tx.path;
    document.getElementById('ruleStatusInput').value = tx.statusCode || 200;
    document.getElementById('ruleBodyInput').value = prettyJsonOrRaw(tx.resBody);
    showToast('📌 Đã điền gói tin vào Trình tạo Mock Rule!');
  });

  document.getElementById('btnCopyCurl').addEventListener('click', () => {
    const tx = state.traffic.find((t) => t.id === state.selectedTxId);
    if (!tx) return;
    const bodyPart = tx.reqBody ? ` -H "Content-Type: application/json" -d '${tx.reqBody.replace(/'/g, "\\'")}'` : '';
    navigator.clipboard.writeText(`curl -i -X ${tx.method} "${getProxyBaseUrl()}${tx.fullPath}"${bodyPart}`);
    showToast('📋 Đã copy lệnh cURL!');
  });

  // Timeline & OpenAPI & Markdown Report Events
  const stopTl = () => api('/api/timeline/stop', { method: 'POST' });
  document.getElementById('btnStopTimeline').addEventListener('click', stopTl);
  document.getElementById('btnStopTimelineBanner').addEventListener('click', stopTl);

  document.getElementById('btnGenerateReport').addEventListener('click', async () => {
    await refreshMarkdownReport();
    showToast('📝 Đã tổng hợp Báo cáo Kiểm định Độ bền Markdown!');
  });

  document.getElementById('btnDownloadReport').addEventListener('click', async () => {
    if (!state.lastMarkdownReport) await refreshMarkdownReport();
    downloadBlob(state.lastMarkdownReport, `chaosforge-audit-report-${Date.now()}.md`, 'text/markdown; charset=utf-8');
  });

  document.getElementById('btnHarvestOpenApi').addEventListener('click', harvestOpenApiNow);

  document.getElementById('btnDownloadOpenApi').addEventListener('click', async () => {
    if (!state.lastOpenApiSpec) await harvestOpenApiNow();
    downloadBlob(JSON.stringify(state.lastOpenApiSpec, null, 2), 'openapi-harvested.json', 'application/json');
  });

  // Rules Form
  resetRuleForm();
  document.getElementById('btnNewRule').addEventListener('click', resetRuleForm);
  document.getElementById('btnResetRuleForm').addEventListener('click', resetRuleForm);

  document.querySelectorAll('[data-insert-var]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = document.getElementById('ruleBodyInput');
      const start = ta.selectionStart || 0;
      ta.value = ta.value.slice(0, start) + btn.dataset.insertVar + ta.value.slice(ta.selectionEnd || start);
      ta.focus();
    });
  });

  document.getElementById('ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('ruleIdInput').value;
    const payload = {
      name: document.getElementById('ruleNameInput').value,
      action: document.getElementById('ruleActionInput').value,
      method: document.getElementById('ruleMethodInput').value,
      pathPattern: document.getElementById('rulePatternInput').value,
      statusCode: Number(document.getElementById('ruleStatusInput').value) || 200,
      delayMs: Number(document.getElementById('ruleDelayInput').value) || 0,
      errorRate: Number(document.getElementById('ruleErrorRateInput').value) || 0,
      responseBody: document.getElementById('ruleBodyInput').value,
      enabled: true
    };
    const res = id
      ? await api(`/api/rules/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/rules', { method: 'POST', body: JSON.stringify(payload) });

    if (res.ok) {
      state.rules = res.rules;
      renderRulesList();
      resetRuleForm();
      showToast('💾 Đã lưu Luật Endpoint!');
    }
  });

  // Cassettes & Chrome .HAR Import/Export
  document.getElementById('btnCreateCassette').addEventListener('click', async () => {
    const name = prompt('Nhập tên Cuộn băng mới:', `Phiên Test ${new Date().toLocaleTimeString('vi-VN')}`);
    if (!name) return;
    const res = await api('/api/cassettes', { method: 'POST', body: JSON.stringify({ name, activate: true, startRecording: true }) });
    if (res.ok) {
      state.cassettes = res.cassettes;
      renderCassettesList();
      loadCassetteDetail(res.cassette.id);
      showToast(`🔴 Đã tạo '${name}' và BẮT ĐẦU GHI BĂNG!`, '#ef4444');
    }
  });

  document.getElementById('inpImportHar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rawText = await file.text();
      const har = JSON.parse(rawText);
      const res = await api('/api/har/import', {
        method: 'POST',
        body: JSON.stringify({ har, name: `HAR: ${file.name}`, activate: true })
      });
      if (res.ok) {
        state.cassettes = res.cassettes;
        renderCassettesList();
        loadCassetteDetail(res.cassette.id);
        showToast(`🌐 Đã nhập ${res.importedCount} API calls từ Chrome .HAR thành Cuộn băng Offline!`, '#22c55e');
      } else {
        showToast(`Lỗi nhập .HAR: ${res.error}`, '#ef4444');
      }
    } catch (err) {
      showToast(`Tệp .HAR lỗi định dạng: ${err.message}`, '#ef4444');
    }
    e.target.value = '';
  });

  document.getElementById('btnExportCassetteHar').addEventListener('click', async () => {
    const har = await api('/api/har/export?source=cassette');
    downloadBlob(JSON.stringify(har, null, 2), `${state.config.activeCassetteId || 'cassette'}.har`, 'application/json');
    showToast('📤 Đã xuất Cuộn băng ra chuẩn Chrome .HAR!');
  });

  document.getElementById('btnSaveCassetteEntry').addEventListener('click', async () => {
    const cas = state.activeCassetteDetail;
    if (!cas || !state.selectedCassetteEntryId) return;
    const idx = cas.entries.findIndex((x) => x.id === state.selectedCassetteEntryId);
    if (idx === -1) return;
    cas.entries[idx].statusCode = Number(document.getElementById('casEntryStatus').value) || 200;
    cas.entries[idx].originalMs = Number(document.getElementById('casEntryMs').value) || 0;
    cas.entries[idx].resBody = document.getElementById('casEntryBody').value;
    const res = await api(`/api/cassettes/${cas.id}`, { method: 'PUT', body: JSON.stringify({ entries: cas.entries }) });
    if (res.ok) {
      state.activeCassetteDetail = res.cassette;
      renderCassetteEntries();
      showToast('💾 Đã lưu bản ghi trong Cuộn băng!');
    }
  });

  document.getElementById('btnResetCassetteCursor').addEventListener('click', async () => {
    if (!state.activeCassetteDetail) return;
    await api(`/api/cassettes/${state.activeCassetteDetail.id}/reset-cursors`, { method: 'POST' });
    showToast('⏮ Đã tua về đầu băng!');
  });

  document.getElementById('btnExportCassette').addEventListener('click', () => {
    if (!state.activeCassetteDetail) return;
    downloadBlob(JSON.stringify(state.activeCassetteDetail, null, 2), `${state.activeCassetteDetail.id}.json`);
  });

  document.getElementById('inpImportCassette').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const res = await api('/api/cassettes', {
        method: 'POST',
        body: JSON.stringify({
          name: parsed.name || file.name.replace(/\.json$/, ''),
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          activate: true
        })
      });
      if (res.ok) {
        state.cassettes = res.cassettes;
        renderCassettesList();
        loadCassetteDetail(res.cassette.id);
        showToast('📥 Đã nhập Cuộn băng!');
      }
    } catch (err) {
      showToast('Lỗi đọc tệp: ' + err.message, '#ef4444');
    }
    e.target.value = '';
  });

  document.getElementById('chkReplayLatency').addEventListener('change', (e) => updateConfig({ replayPreserveLatency: e.target.checked }));
  document.getElementById('chkReplayChaos').addEventListener('change', (e) => updateConfig({ replayApplyChaos: e.target.checked }));
  document.getElementById('chkAutoFallbackOffline').addEventListener('change', (e) => updateConfig({ autoFallbackOffline: e.target.checked }));

  // Lab Controls & v2.0 Probes
  const setArmorMode = (mode) => {
    state.uiArmorMode = mode;
    const btnF = document.getElementById('btnModeFragile');
    const btnR = document.getElementById('btnModeResilient');
    const badge = document.getElementById('victimArmorBadge');
    if (mode === 'FRAGILE') {
      btnF.className = 'armor-btn active-fragile';
      btnR.className = 'armor-btn';
      badge.className = 'armor-indicator fragile';
      badge.textContent = 'CHẾ ĐỘ NGÂY THƠ';
    } else {
      btnF.className = 'armor-btn';
      btnR.className = 'armor-btn active-resilient';
      badge.className = 'armor-indicator resilient';
      badge.textContent = 'CHẾ ĐỘ PHÒNG THỦ v2.0';
    }
    victimLoadStoreData();
  };

  document.getElementById('btnModeFragile').addEventListener('click', () => setArmorMode('FRAGILE'));
  document.getElementById('btnModeResilient').addEventListener('click', () => setArmorMode('RESILIENT'));
  document.getElementById('btnVictimReload').addEventListener('click', () => victimLoadStoreData());
  document.getElementById('btnVictimCheckout').addEventListener('click', () => victimTriggerCheckout());
  document.getElementById('btnProbeAiStream').addEventListener('click', victimRunAiStream);
  document.getElementById('btnProbeWsToggle').addEventListener('click', victimToggleWebSocket);
  document.getElementById('btnProbeAuthBurst').addEventListener('click', victimTestAuth401Burst);
  document.getElementById('btnProbeGraphql').addEventListener('click', victimTestGraphql);

  document.getElementById('btnClearVictimLog').addEventListener('click', () => {
    document.getElementById('victimConsole').innerHTML = '';
  });

  document.getElementById('btnVictimTrack').addEventListener('click', async () => {
    const box = document.getElementById('victimTrackBox');
    try {
      const data =
        state.uiArmorMode === 'RESILIENT'
          ? await fetchResilientClient('/orders/track', { timeoutMs: 4000, maxRetries: 2 })
          : await (await fetch(`${getProxyBaseUrl()}/orders/track`)).json();
      box.classList.remove('hidden');
      box.innerHTML = `📦 Đơn <b>${escapeHtml(String(data.orderId || 'ORD'))}</b> — Bước ${Number(data.step) || 1}/3: <b>${escapeHtml(String(data.statusLabel || data.status))}</b> (${Number(data.progressPct) || 0}%)`;
    } catch (err) {
      logVictimConsole(`Lỗi tải tiến độ đơn: ${err.message}`, 'err');
    }
  });

  document.getElementById('btnVictimResetStore').addEventListener('click', async () => {
    await api('/api/demo/reset', { method: 'POST' });
    state.telemetry.doubleSubmitIncidents = 0;
    state.telemetry.authRaceIncidents = 0;
    renderTelemetry();
    victimLoadStoreData();
    showToast('♻️ Đã đặt lại Ví 18.5tr & bộ đếm Race!');
  });

  document.getElementById('btnRunBenchmark').addEventListener('click', runAutomatedBenchmark);

  // Floating HUD Live Preview & Copy
  document.getElementById('btnPreviewHudHere').addEventListener('click', () => {
    if (window.__CHAOSFORGE_HUD_MOUNTED__) {
      showToast('⚡ Floating Chaos HUD đã đang hiển thị ở góc dưới bên trái màn hình!');
      return;
    }
    const s = document.createElement('script');
    s.src = '/chaos-hud.js';
    document.body.appendChild(s);
    showToast('✨ Đã gắn Floating Chaos HUD ở góc dưới bên trái màn hình!');
  });

  document.getElementById('btnCopyResilientCode').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('preResilientPattern').innerText);
    showToast('📋 Đã copy trọn bộ fetchResilient + AuthRefreshMutex!');
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', initApp);
