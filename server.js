/**
 * ⚡ ChaosForge v2.0 — API Chaos, Streaming/WS, Auth/GraphQL & Offline Reverse Proxy
 * Zero-dependency Node.js Server (Node v18+)
 *
 * • Port 4190: ChaosForge Cockpit UI + Control API (/api/*) + SSE (/api/events)
 *              + Floating HUD (/chaos-hud.js) + Demo API/SSE/WS/GraphQL (/demo-api/*)
 * • Port 4191: Dedicated Transparent Reverse Proxy Gateway (HTTP + SSE + WebSocket + GraphQL)
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { performance } = require('node:perf_hooks');

const {
  getActiveWsList,
  killAllWebSockets,
  handleDemoAiStream,
  isStreamRequestOrHeader,
  proxySseUpstream,
  handleDemoWsUpgrade,
  handleProxyWsUpgrade
} = require('./lib/ws_sse_engine');

const {
  importHarToCassette,
  exportToHar,
  harvestOpenApiSpec
} = require('./lib/har_openapi');

const {
  TimelineRunner,
  generateMarkdownAuditReport
} = require('./lib/timeline_report');

const PORT = Number(process.env.PORT || 4190);
const PROXY_PORT = Number(process.env.PROXY_PORT || 4191);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CASSETTES_DIR = path.join(DATA_DIR, 'cassettes');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const MAX_TRAFFIC_LOGS = 250;
const MAX_BODY_CAPTURE = 256 * 1024;
const MAX_HAR_BODY_BYTES = 15 * 1024 * 1024; // Allow up to 15MB .HAR import

for (const dir of [PUBLIC_DIR, DATA_DIR, CASSETTES_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// 1. KỊCH BẢN HỖN LOẠN MẪU (1-CLICK CHAOS PRESETS)
// ============================================================================

const CHAOS_PRESETS = {
  clean: {
    id: 'clean',
    name: '🟢 Mạng Cáp Quang Sạch (Clean 0ms)',
    badge: 'CLEAN',
    description: 'Chuyển tiếp nguyên bản không độ trễ, không tiêm lỗi để đo baseline.',
    mode: 'PASSTHROUGH',
    chaos: {
      latencyMs: 0, jitterMs: 0, spikeRate: 0, spikeMs: 3000,
      errorRate: 0, errorCodes: [500, 502, 503, 429],
      dropRate: 0, hangRate: 0, hangMs: 12000, throttleKbps: 0, stripCorsRate: 0
    },
    mutator: {
      enabled: false, mutationRate: 100, nullifyFields: false, emptyArrays: false,
      overflowStrings: false, typeConfusion: false, truncateJson: false, htmlInsteadOfJson: false
    },
    streamChaos: { enabled: false },
    graphqlChaos: { enabled: false }
  },
  elevator_3g: {
    id: 'elevator_3g',
    name: '🟡 3G Thang Máy & Lag Đột Biến (3s+)',
    badge: 'SLOW 3G',
    description: 'Độ trễ nền 1.8s + Jitter 1.4s, bóp băng thông 12 KB/s & 25% vọt lên 4.5s. Bẫy lỗi Double-Click & Race Condition!',
    mode: 'CHAOS',
    chaos: {
      latencyMs: 1800, jitterMs: 1400, spikeRate: 25, spikeMs: 4500,
      errorRate: 5, errorCodes: [504, 503],
      dropRate: 0, hangRate: 0, hangMs: 12000, throttleKbps: 12, stripCorsRate: 0
    },
    mutator: { enabled: false },
    streamChaos: { enabled: true, tokenDelayMs: 120, stallMidStreamMs: 2000, dropMidStreamRate: 0, corruptEventRate: 0, duplicateChunkRate: 0 }
  },
  rate_limit_storm: {
    id: 'rate_limit_storm',
    name: '🟠 Bão Flash Sale Quá Tải (429 / 503)',
    badge: '429 STORM',
    description: '45% request bị từ chối bởi 429 Too Many Requests (kèm Retry-After: 2s) & 503 Service Unavailable để thử cơ chế Exponential Backoff.',
    mode: 'CHAOS',
    chaos: {
      latencyMs: 220, jitterMs: 350, spikeRate: 15, spikeMs: 2500,
      errorRate: 45, errorCodes: [429, 429, 503],
      dropRate: 0, hangRate: 0, hangMs: 12000, throttleKbps: 0, stripCorsRate: 0
    },
    mutator: { enabled: false }
  },
  backend_fire: {
    id: 'backend_fire',
    name: '🔴 Backend Bốc Cháy (500 + Rớt Socket + Treo)',
    badge: 'OUTAGE',
    description: '35% lỗi 500/502, 15% đứt kết nối TCP đột ngột (ERR_EMPTY_RESPONSE) và 15% treo cứng 10 giây kiểm tra AbortController Timeout.',
    mode: 'CHAOS',
    chaos: {
      latencyMs: 350, jitterMs: 500, spikeRate: 20, spikeMs: 3000,
      errorRate: 35, errorCodes: [500, 502, 503, 504],
      dropRate: 15, hangRate: 15, hangMs: 10000, throttleKbps: 0, stripCorsRate: 0
    },
    mutator: { enabled: false }
  },
  json_crasher: {
    id: 'json_crasher',
    name: '🟣 Sát Thủ Giao Diện (200 OK nhưng JSON Dị Dạng)',
    badge: 'MUTATOR',
    description: 'Vẫn trả HTTP 200 OK nhưng biến các trường dữ liệu thành null, đảo kiểu số/chuỗi và kéo giãn chuỗi cực dài để bắt lỗi trắng trang & vỡ CSS!',
    mode: 'CHAOS',
    chaos: {
      latencyMs: 120, jitterMs: 180, spikeRate: 0, spikeMs: 3000,
      errorRate: 0, errorCodes: [500], dropRate: 0, hangRate: 0, hangMs: 12000, throttleKbps: 0, stripCorsRate: 0
    },
    mutator: {
      enabled: true, mutationRate: 100, nullifyFields: true, emptyArrays: false,
      overflowStrings: true, typeConfusion: true, truncateJson: false, htmlInsteadOfJson: false
    }
  },
  ai_stream_glitch: {
    id: 'ai_stream_glitch',
    name: '🤖 Nhiễu Sóng AI Stream & GraphQL Partial Error',
    badge: 'AI / GQL',
    description: 'Khựng luồng chữ SSE 2.5s giữa câu, 35% đứt stream đột ngột & tiêm lỗi Partial Data vào GraphQL dù HTTP vẫn 200 OK!',
    mode: 'CHAOS',
    chaos: {
      latencyMs: 80, jitterMs: 100, spikeRate: 0, spikeMs: 2500,
      errorRate: 0, errorCodes: [502], dropRate: 0, hangRate: 0, hangMs: 12000, throttleKbps: 0, stripCorsRate: 0
    },
    mutator: { enabled: false },
    streamChaos: {
      enabled: true, tokenDelayMs: 85, stallMidStreamMs: 2500,
      dropMidStreamRate: 35, corruptEventRate: 35, duplicateChunkRate: 20
    },
    graphqlChaos: {
      enabled: true, targetOperations: '*', errors200Rate: 0, partialDataRate: 100
    }
  }
};

// ============================================================================
// 2. KHỞI TẠO STORE & CUỘN BĂNG MẪU
// ============================================================================

function createDefaultStore() {
  return {
    config: {
      targetUrl: `http://127.0.0.1:${PORT}/demo-api`,
      mode: 'CHAOS',
      recording: false,
      activeCassetteId: 'cas-demo-baseline',
      replayPreserveLatency: false,
      replayApplyChaos: false,
      corsBypass: true,
      autoFallbackOffline: false,
      activePreset: 'clean',
      chaos: {
        latencyMs: 0,
        jitterMs: 0,
        spikeRate: 0,
        spikeMs: 3200,
        errorRate: 0,
        errorCodes: [500, 502, 503, 429],
        dropRate: 0,
        hangRate: 0,
        hangMs: 10000,
        throttleKbps: 0,
        stripCorsRate: 0
      },
      mutator: {
        enabled: false,
        mutationRate: 100,
        nullifyFields: false,
        targetKeys: 'items, products, user.avatar, balance, discount',
        emptyArrays: false,
        overflowStrings: false,
        typeConfusion: false,
        truncateJson: false,
        htmlInsteadOfJson: false,
        jsonOverrides: '{}'
      },
      streamChaos: {
        enabled: false,
        tokenDelayMs: 60,
        stallMidStreamMs: 2200,
        dropMidStreamRate: 0,
        corruptEventRate: 0,
        duplicateChunkRate: 0
      },
      wsChaos: {
        enabled: false,
        frameDelayMs: 0,
        rejectHandshakeRate: 0,
        autoDropAfterSec: 0
      },
      authChaos: {
        enabled: false,
        expireEveryN: 0,
        refreshPathPattern: '*/auth/refresh*'
      },
      graphqlChaos: {
        enabled: false,
        targetOperations: '*',
        errors200Rate: 0,
        partialDataRate: 100
      },
      breakpoints: {
        interceptRequest: false,
        interceptResponse: false,
        filterPattern: '*',
        timeoutSec: 60
      }
    },
    rules: [
      {
        id: 'rule-mock-flags',
        name: 'Mock Động: Feature Flags & Bảo Trì',
        enabled: true,
        method: 'GET',
        pathPattern: '/feature-flags',
        action: 'MOCK',
        delayMs: 40,
        errorRate: 0,
        statusCode: 200,
        contentType: 'application/json',
        responseBody: JSON.stringify(
          {
            ok: true,
            requestId: '{{uuid}}',
            serverTime: '{{isoDate}}',
            flags: {
              newCheckoutV2: true,
              darkModeCockpit: true,
              maintenanceBanner: false,
              abBucket: 'variant_B'
            }
          },
          null,
          2
        ),
        mutatorOverride: null
      },
      {
        id: 'rule-checkout-stress',
        name: 'Thử Thách Thanh Toán: Lag 3s + 40% Lỗi 429',
        enabled: false,
        method: 'POST',
        pathPattern: '/checkout*',
        action: 'CHAOS',
        delayMs: 3000,
        errorRate: 40,
        statusCode: 429,
        contentType: 'application/json',
        responseBody: JSON.stringify(
          {
            error: 'RATE_LIMITED',
            message: 'Cổng thanh toán đang quá tải, vui lòng thử lại sau 2 giây.',
            retryAfterSec: 2
          },
          null,
          2
        ),
        mutatorOverride: null
      },
      {
        id: 'rule-empty-products',
        name: 'Test Empty State: Trả Mảng Rỗng Cho /products',
        enabled: false,
        method: 'GET',
        pathPattern: '/products*',
        action: 'CHAOS',
        delayMs: 150,
        errorRate: 0,
        statusCode: 200,
        contentType: 'application/json',
        responseBody: '',
        mutatorOverride: { emptyArrays: true }
      },
      {
        id: 'rule-bp-checkout',
        name: 'Phẫu Thuật Sống (Breakpoint): Bắt Gói Tin /checkout',
        enabled: false,
        method: 'POST',
        pathPattern: '/checkout*',
        action: 'BREAKPOINT',
        delayMs: 0,
        errorRate: 0,
        statusCode: 200,
        contentType: 'application/json',
        responseBody: '',
        mutatorOverride: null
      }
    ]
  };
}

function ensureDemoCassette() {
  const demoFile = path.join(CASSETTES_DIR, 'cas-demo-baseline.json');
  if (fs.existsSync(demoFile)) return;
  const now = new Date().toISOString();
  const demoCassette = {
    id: 'cas-demo-baseline',
    name: 'Cuộn Băng Mẫu — PayFlow Store Offline (6 bản ghi)',
    createdAt: now,
    updatedAt: now,
    description: 'Bản ghi mẫu đầy đủ các API Ví, Sản phẩm, Đặt hàng & Theo dõi đơn 3 trạng thái để test Offline ngay lập tức.',
    entries: [
      {
        id: 'rec-summary-1',
        recordedAt: now,
        method: 'GET',
        path: '/dashboard/summary',
        fullPath: '/dashboard/summary',
        statusCode: 200,
        originalMs: 42,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify(
          {
            ok: true,
            source: 'PayFlow Core v2 (Offline Snapshot)',
            user: { id: 'usr_9901', name: 'Minh Trần', tier: 'PLATINUM', avatar: '🧑‍💻' },
            wallet: { balance: 18500000, currency: 'VND', pendingCashback: 420000 },
            alerts: [{ id: 'al_1', level: 'info', text: 'Phiên bản Offline Cassette đang phát lại mượt mà không cần Backend!' }]
          },
          null,
          2
        )
      },
      {
        id: 'rec-products-1',
        recordedAt: now,
        method: 'GET',
        path: '/products',
        fullPath: '/products',
        statusCode: 200,
        originalMs: 58,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify(
          {
            ok: true,
            updatedAt: now,
            products: [
              { id: 'sku_keychron', name: 'Bàn phím cơ Keychron Q1 Pro Wireless', price: 4290000, stock: 8, badge: 'FLASH SALE' },
              { id: 'sku_sony_xm5', name: 'Tai nghe chống ồn Sony WH-1000XM5', price: 6490000, stock: 3, badge: 'SẮP HẾT' },
              { id: 'sku_ssd_2tb', name: 'Ổ cứng NVMe Samsung 990 PRO 2TB', price: 3850000, stock: 19, badge: 'BÁN CHẠY' },
              { id: 'sku_dock_tb4', name: 'Thunderbolt 4 Dock 12-in-1 Dual 4K', price: 5190000, stock: 5, badge: 'MỚI' }
            ]
          },
          null,
          2
        )
      },
      {
        id: 'rec-track-step1',
        recordedAt: now,
        method: 'GET',
        path: '/orders/track',
        fullPath: '/orders/track',
        statusCode: 200,
        originalMs: 35,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify({ ok: true, orderId: 'ORD-2026-881', step: 1, status: 'PACKING', statusLabel: 'Đang đóng gói tại kho Quận 7', progressPct: 35 }, null, 2)
      },
      {
        id: 'rec-track-step2',
        recordedAt: now,
        method: 'GET',
        path: '/orders/track',
        fullPath: '/orders/track',
        statusCode: 200,
        originalMs: 39,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify({ ok: true, orderId: 'ORD-2026-881', step: 2, status: 'IN_TRANSIT', statusLabel: 'Tài xế đang giao hàng (cách 1.8km)', progressPct: 75 }, null, 2)
      },
      {
        id: 'rec-track-step3',
        recordedAt: now,
        method: 'GET',
        path: '/orders/track',
        fullPath: '/orders/track',
        statusCode: 200,
        originalMs: 31,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify({ ok: true, orderId: 'ORD-2026-881', step: 3, status: 'DELIVERED', statusLabel: 'Giao thành công — Đã ký nhận!', progressPct: 100 }, null, 2)
      },
      {
        id: 'rec-checkout-1',
        recordedAt: now,
        method: 'POST',
        path: '/checkout',
        fullPath: '/checkout',
        statusCode: 200,
        originalMs: 95,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resBody: JSON.stringify({ ok: true, orderId: 'ORD-OFFLINE-9001', chargedAmount: 4290000, message: 'Thanh toán thành công (Phát lại từ Cassette Offline)!' }, null, 2)
      }
    ]
  };
  fs.writeFileSync(demoFile, JSON.stringify(demoCassette, null, 2), 'utf8');
}

function loadStore() {
  ensureDemoCassette();
  const def = createDefaultStore();
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      const rc = raw.config || {};
      return {
        config: {
          ...def.config,
          ...rc,
          chaos: { ...def.config.chaos, ...(rc.chaos || {}) },
          mutator: { ...def.config.mutator, ...(rc.mutator || {}) },
          streamChaos: { ...def.config.streamChaos, ...(rc.streamChaos || {}) },
          wsChaos: { ...def.config.wsChaos, ...(rc.wsChaos || {}) },
          authChaos: { ...def.config.authChaos, ...(rc.authChaos || {}) },
          graphqlChaos: { ...def.config.graphqlChaos, ...(rc.graphqlChaos || {}) },
          breakpoints: { ...def.config.breakpoints, ...(rc.breakpoints || {}) }
        },
        rules: Array.isArray(raw.rules) ? raw.rules : def.rules
      };
    }
  } catch (err) {
    console.error('[Store] Lỗi đọc store.json, khởi tạo mặc định:', err.message);
  }
  saveStore(def);
  return def;
}

function saveStore(stateObj = store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(stateObj, null, 2), 'utf8');
  } catch (err) {
    console.error('[Store] Không thể ghi store.json:', err.message);
  }
}

let store = loadStore();

// Runtime states
const trafficLogs = [];
const sseClients = new Set();
const activeBreakpoints = new Map();
const cassetteSequenceCursors = new Map();

const demoBackendState = {
  walletBalance: 18500000,
  orders: [],
  seenIdempotencyKeys: new Map(),
  recentRawCheckouts: [],
  doubleSubmitIncidents: 0,
  trackStep: 0
};

// Auth 401 Burst & Refresh Race Detector state
const authRuntime = {
  forceExpired: false,
  authedReqCounter: 0,
  issuedTokenVersion: 1,
  recentRefreshCalls: [], // timestamps within last 1600ms
  raceIncidents: 0,
  refreshSuccessCount: 0
};

function mergeConfigPatch(patch = {}) {
  if (patch.targetUrl !== undefined) store.config.targetUrl = String(patch.targetUrl).trim();
  if (patch.mode !== undefined) store.config.mode = patch.mode;
  if (patch.recording !== undefined) store.config.recording = Boolean(patch.recording);
  if (patch.activeCassetteId !== undefined) store.config.activeCassetteId = String(patch.activeCassetteId);
  if (patch.replayPreserveLatency !== undefined) store.config.replayPreserveLatency = Boolean(patch.replayPreserveLatency);
  if (patch.replayApplyChaos !== undefined) store.config.replayApplyChaos = Boolean(patch.replayApplyChaos);
  if (patch.corsBypass !== undefined) store.config.corsBypass = Boolean(patch.corsBypass);
  if (patch.autoFallbackOffline !== undefined) store.config.autoFallbackOffline = Boolean(patch.autoFallbackOffline);
  if (patch.activePreset !== undefined) store.config.activePreset = String(patch.activePreset);

  for (const subKey of ['chaos', 'mutator', 'streamChaos', 'wsChaos', 'authChaos', 'graphqlChaos', 'breakpoints']) {
    if (patch[subKey] && typeof patch[subKey] === 'object') {
      store.config[subKey] = { ...store.config[subKey], ...patch[subKey] };
    }
  }
}

// Initialize Timeline Storyboard Runner
const timelineRunner = new TimelineRunner({
  applyPatchFn: (patch) => {
    mergeConfigPatch(patch);
    broadcastSse('state:updated', { config: store.config });
  },
  restoreConfigFn: (savedCfg) => {
    store.config = savedCfg;
    saveStore();
    broadcastSse('state:updated', { config: store.config });
  },
  getSnapshotFn: () => store.config,
  killWsFn: () => {
    const killed = killAllWebSockets();
    broadcastSse('ws:killed_all', { killed });
  },
  expireAuthFn: () => {
    authRuntime.forceExpired = true;
    store.config.authChaos.enabled = true;
    broadcastSse('auth:expired_armed', { armed: true });
  },
  broadcastFn: (event, data) => broadcastSse(event, data)
});

// ============================================================================
// 3. QUẢN LÝ CASSETTE
// ============================================================================

function listCassettesMeta() {
  try {
    const files = fs.readdirSync(CASSETTES_DIR).filter((f) => f.endsWith('.json'));
    return files
      .map((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CASSETTES_DIR, file), 'utf8'));
          return {
            id: data.id || file.replace(/\.json$/, ''),
            name: data.name || file,
            description: data.description || '',
            createdAt: data.createdAt || null,
            updatedAt: data.updatedAt || null,
            entryCount: Array.isArray(data.entries) ? data.entries.length : 0
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch {
    return [];
  }
}

function readCassette(cassetteId) {
  const safeId = String(cassetteId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const file = path.join(CASSETTES_DIR, `${safeId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCassette(cassette) {
  const safeId = String(cassette.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Cassette ID không hợp lệ');
  cassette.id = safeId;
  cassette.updatedAt = new Date().toISOString();
  if (!cassette.createdAt) cassette.createdAt = cassette.updatedAt;
  if (!Array.isArray(cassette.entries)) cassette.entries = [];
  const file = path.join(CASSETTES_DIR, `${safeId}.json`);
  fs.writeFileSync(file, JSON.stringify(cassette, null, 2), 'utf8');
  return cassette;
}

function recordToActiveCassette(entry) {
  const activeId = store.config.activeCassetteId || 'cas-demo-baseline';
  let cassette = readCassette(activeId);
  if (!cassette) {
    cassette = {
      id: activeId,
      name: `Phiên Ghi ${new Date().toLocaleTimeString('vi-VN')}`,
      description: 'Tự động ghi từ lưu lượng Proxy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: []
    };
  }
  cassette.entries.push({
    id: 'rec-' + crypto.randomBytes(4).toString('hex'),
    recordedAt: new Date().toISOString(),
    method: entry.method,
    path: entry.path,
    fullPath: entry.fullPath,
    reqBodyHash: hashBody(entry.reqBody),
    reqBodySample: (entry.reqBody || '').slice(0, 1024),
    statusCode: entry.statusCode,
    originalMs: entry.upstreamMs || 25,
    headers: sanitizeRecordedHeaders(entry.headers),
    resBody: entry.resBody
  });
  if (cassette.entries.length > 350) {
    cassette.entries = cassette.entries.slice(-350);
  }
  writeCassette(cassette);
  broadcastSse('cassette:updated', {
    cassetteId: cassette.id,
    entryCount: cassette.entries.length
  });
}

function matchCassetteEntry(cassetteId, method, pathname, fullPath, reqBody) {
  const cassette = readCassette(cassetteId);
  if (!cassette || !Array.isArray(cassette.entries) || cassette.entries.length === 0) {
    return null;
  }
  const upperMethod = method.toUpperCase();
  const bodyHash = hashBody(reqBody);

  let candidates = cassette.entries.filter(
    (e) => e.method === upperMethod && e.fullPath === fullPath && (!e.reqBodyHash || !reqBody || e.reqBodyHash === bodyHash)
  );
  if (candidates.length === 0) {
    candidates = cassette.entries.filter((e) => e.method === upperMethod && e.fullPath === fullPath);
  }
  if (candidates.length === 0) {
    candidates = cassette.entries.filter((e) => e.method === upperMethod && e.path === pathname);
  }
  if (candidates.length === 0) return null;

  const cursorKey = `${cassetteId}:${upperMethod}:${fullPath}`;
  const cursor = cassetteSequenceCursors.get(cursorKey) || 0;
  const chosen = candidates[cursor % candidates.length];
  cassetteSequenceCursors.set(cursorKey, cursor + 1);
  return {
    entry: chosen,
    sequenceIndex: (cursor % candidates.length) + 1,
    sequenceTotal: candidates.length
  };
}

function hashBody(body) {
  if (!body) return '';
  return crypto.createHash('sha1').update(String(body)).digest('hex').slice(0, 12);
}

function sanitizeRecordedHeaders(headers = {}) {
  const out = {};
  const keep = ['content-type', 'cache-control', 'x-request-id', 'retry-after'];
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (keep.includes(lk) || lk.startsWith('x-')) {
      out[lk] = headers[k];
    }
  }
  if (!out['content-type']) out['content-type'] = 'application/json; charset=utf-8';
  return out;
}

// ============================================================================
// 4. GRAPHQL DETECTOR & GRAPHQL CHAOS MUTATOR + JSON EDGE-CASE MUTATOR
// ============================================================================

function extractGraphqlInfo(pathname, reqBodyStr) {
  if (!reqBodyStr) return null;
  const looksGqlPath = String(pathname || '').toLowerCase().includes('graphql');
  const parsed = safeJsonParse(reqBodyStr);
  if (!parsed || typeof parsed !== 'object') return null;

  if (typeof parsed.query === 'string' && (looksGqlPath || parsed.query.includes('{') || parsed.operationName)) {
    let opName = parsed.operationName || '';
    if (!opName) {
      const m = parsed.query.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/);
      opName = m ? m[2] : 'AnonymousGQL';
    }
    const kindMatch = parsed.query.match(/^\s*(mutation|subscription|query)/i);
    return {
      operationName: opName,
      operationType: kindMatch ? kindMatch[1].toLowerCase() : 'query',
      query: parsed.query,
      variables: parsed.variables || {}
    };
  }
  return null;
}

function applyGraphqlChaos(rawResStr, gqlInfo, gqlChaosCfg) {
  if (!gqlInfo || !gqlChaosCfg || !gqlChaosCfg.enabled) return null;
  const targets = String(gqlChaosCfg.targetOperations || '*').trim();
  if (targets !== '*' && targets !== '') {
    const allowed = targets.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(gqlInfo.operationName.toLowerCase())) {
      return null;
    }
  }

  // 1. Full GraphQL 200 OK Error Payload (data: null, errors: [...])
  if (Number(gqlChaosCfg.errors200Rate) > 0 && Math.random() * 100 < Number(gqlChaosCfg.errors200Rate)) {
    return {
      mutated: true,
      badge: `GQL_ERR(${gqlInfo.operationName})`,
      body: JSON.stringify(
        {
          data: null,
          errors: [
            {
              message: `ChaosForge GraphQL Resolver Failure in '${gqlInfo.operationName}'`,
              path: [gqlInfo.operationName],
              extensions: {
                code: 'DOWNSTREAM_SERVICE_ERROR',
                chaosInjected: true
              }
            }
          ]
        },
        null,
        2
      )
    };
  }

  // 2. Partial Data + Errors (nullify one root data field & attach errors[])
  if (Number(gqlChaosCfg.partialDataRate) > 0 && Math.random() * 100 < Number(gqlChaosCfg.partialDataRate)) {
    const parsed = safeJsonParse(rawResStr);
    if (parsed && parsed.data && typeof parsed.data === 'object') {
      const dataKeys = Object.keys(parsed.data);
      const nulledField = dataKeys.length > 0 ? dataKeys[0] : 'node';
      if (dataKeys.length > 0) {
        parsed.data[nulledField] = null;
      }
      parsed.errors = [
        ...(Array.isArray(parsed.errors) ? parsed.errors : []),
        {
          message: `Partial Data Chaos: trường '${nulledField}' không tải được từ microservice phụ`,
          path: [nulledField],
          extensions: { code: 'PARTIAL_RESOLVER_TIMEOUT', chaosInjected: true }
        }
      ];
      return {
        mutated: true,
        badge: `GQL_PARTIAL(${nulledField})`,
        body: JSON.stringify(parsed, null, 2)
      };
    }
  }
  return null;
}

function parseTargetKeys(rawStr) {
  return String(rawStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function setByDotPath(obj, dotPath, val) {
  if (!obj || typeof obj !== 'object') return false;
  const parts = dotPath.split('.').filter(Boolean);
  if (parts.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = val;
  return true;
}

function applyJsonMutations(rawBodyStr, contentType, mutatorCfg) {
  const applied = [];

  if (mutatorCfg.htmlInsteadOfJson) {
    applied.push('HTML_INSTEAD_OF_JSON');
    return {
      mutated: true,
      applied,
      newContentType: 'text/html; charset=utf-8',
      body: [
        '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head>',
        '<body bgcolor="white"><center><h1>502 Bad Gateway</h1></center>',
        '<hr><center>nginx/1.25.4 (ChaosForge Unexpected HTML Proxy Response)</center></body></html>'
      ].join('\n')
    };
  }

  const looksJson =
    String(contentType || '').toLowerCase().includes('json') ||
    (rawBodyStr && (rawBodyStr.trim().startsWith('{') || rawBodyStr.trim().startsWith('[')));

  if (!looksJson || !rawBodyStr || !rawBodyStr.trim()) {
    return { mutated: false, applied: [], newContentType: contentType, body: rawBodyStr };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBodyStr);
  } catch {
    return { mutated: false, applied: [], newContentType: contentType, body: rawBodyStr };
  }

  const targetKeys = parseTargetKeys(mutatorCfg.targetKeys);
  const targetLeafSet = new Set(targetKeys.map((k) => k.split('.').pop().toLowerCase()));

  function walkMutate(node, currentPath = '') {
    if (node === null || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
      if (mutatorCfg.emptyArrays) {
        if (node.length > 0 && !applied.includes('EMPTY_ARRAYS')) applied.push('EMPTY_ARRAYS');
        return [];
      }
      return node.map((item, idx) => walkMutate(item, `${currentPath}[${idx}]`));
    }

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const nextPath = currentPath ? `${currentPath}.${k}` : k;
      const lowerKey = k.toLowerCase();

      if (mutatorCfg.nullifyFields && (targetKeys.includes(nextPath) || targetLeafSet.has(lowerKey))) {
        out[k] = null;
        if (!applied.includes(`NULLIFY(${k})`)) applied.push(`NULLIFY(${k})`);
        continue;
      }

      if (mutatorCfg.emptyArrays && Array.isArray(v)) {
        out[k] = [];
        if (!applied.includes(`EMPTY_ARRAY(${k})`)) applied.push(`EMPTY_ARRAY(${k})`);
        continue;
      }

      if (
        mutatorCfg.overflowStrings &&
        typeof v === 'string' &&
        !['id', 'orderid', 'currency', 'step'].includes(lowerKey)
      ) {
        const chunk = v || 'TEXT';
        out[k] = `[OVERFLOW_TEST] ${chunk.repeat(6)} ${'🔥'.repeat(12)} ${'W'.repeat(95)}`;
        if (!applied.includes('OVERFLOW_STRINGS')) applied.push('OVERFLOW_STRINGS');
        continue;
      }

      if (mutatorCfg.typeConfusion && typeof v === 'number') {
        out[k] =
          lowerKey.includes('price') || lowerKey.includes('balance') || lowerKey.includes('amount')
            ? -99999999
            : String(v) + '_STR_TYPE';
        if (!applied.includes('TYPE_CONFUSION')) applied.push('TYPE_CONFUSION');
        continue;
      }

      out[k] = walkMutate(v, nextPath);
    }
    return out;
  }

  let resultObj = walkMutate(parsed, '');

  if (
    mutatorCfg.nullifyFields &&
    !applied.some((x) => x.startsWith('NULLIFY')) &&
    resultObj &&
    typeof resultObj === 'object' &&
    !Array.isArray(resultObj)
  ) {
    const candidateKey = Object.keys(resultObj).find(
      (k) => k !== 'ok' && resultObj[k] !== null && typeof resultObj[k] === 'object'
    );
    if (candidateKey) {
      resultObj[candidateKey] = null;
      applied.push(`NULLIFY(${candidateKey})`);
    }
  }

  if (mutatorCfg.jsonOverrides && String(mutatorCfg.jsonOverrides).trim()) {
    try {
      const overrides = JSON.parse(mutatorCfg.jsonOverrides);
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const [dotKey, val] of Object.entries(overrides)) {
          if (setByDotPath(resultObj, dotKey, val)) {
            applied.push(`OVERRIDE(${dotKey})`);
          }
        }
      }
    } catch {}
  }

  let serialized = JSON.stringify(resultObj, null, 2);

  if (mutatorCfg.truncateJson && serialized.length > 20) {
    const cutPoint = Math.max(12, Math.floor(serialized.length * 0.62));
    serialized = serialized.slice(0, cutPoint) + ' /* ⚡ TRUNCATED_BY_CHAOSFORGE';
    applied.push('TRUNCATE_MALFORMED_JSON');
  }

  return {
    mutated: applied.length > 0,
    applied,
    newContentType: contentType || 'application/json; charset=utf-8',
    body: serialized
  };
}

// ============================================================================
// 5. ROUTE MATCHER, TEMPLATE RENDERER & BREAKPOINT ENGINE
// ============================================================================

function matchPattern(pattern, pathname) {
  if (!pattern || pattern === '*') return { matched: true, params: {} };
  const cleanPattern = pattern.trim();
  const paramNames = [];
  const regexStr =
    '^' +
    cleanPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) +
    '$';

  const re = new RegExp(regexStr, 'i');
  const m = pathname.match(re);
  if (!m) return { matched: false, params: {} };
  const params = {};
  paramNames.forEach((name, idx) => {
    params[name] = decodeURIComponent(m[idx + 1] || '');
  });
  return { matched: true, params };
}

function findMatchingRule(method, pathname) {
  const upper = method.toUpperCase();
  for (const rule of store.rules) {
    if (!rule.enabled) continue;
    if (rule.method && rule.method !== 'ALL' && rule.method.toUpperCase() !== upper) continue;
    const { matched, params } = matchPattern(rule.pathPattern || '*', pathname);
    if (matched) return { rule, params };
  }
  return null;
}

function renderDynamicTemplate(templateStr, ctx) {
  if (!templateStr) return '';
  return String(templateStr).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, expr) => {
    if (expr === 'uuid') return crypto.randomUUID();
    if (expr === 'timestamp') return String(Date.now());
    if (expr === 'isoDate') return new Date().toISOString();
    if (expr === 'randInt') return String(Math.floor(1000 + Math.random() * 9000));
    if (expr === 'req.method') return ctx.method;
    if (expr === 'req.path') return ctx.pathname;
    if (expr.startsWith('req.params.')) {
      const k = expr.slice('req.params.'.length);
      return ctx.params && ctx.params[k] !== undefined ? String(ctx.params[k]) : '';
    }
    if (expr.startsWith('req.query.')) {
      const k = expr.slice('req.query.'.length);
      return ctx.query && ctx.query[k] !== undefined ? String(ctx.query[k]) : '';
    }
    if (expr.startsWith('req.body.')) {
      const k = expr.slice('req.body.'.length);
      if (ctx.reqJson && typeof ctx.reqJson === 'object' && ctx.reqJson[k] !== undefined) {
        return String(ctx.reqJson[k]);
      }
      return '';
    }
    return '';
  });
}

function holdForBreakpoint(phase, payload) {
  const bpId = 'bp-' + crypto.randomBytes(4).toString('hex');
  const timeoutSec = Math.max(5, Math.min(300, Number(store.config.breakpoints.timeoutSec) || 60));
  const expiresAt = Date.now() + timeoutSec * 1000;

  const meta = {
    id: bpId,
    phase,
    createdAt: new Date().toISOString(),
    expiresAt,
    timeoutSec,
    ...payload
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      activeBreakpoints.delete(bpId);
      broadcastSse('breakpoint:resolved', { id: bpId, reason: 'timeout_auto_resume' });
      resolve({ action: 'resume', timedOut: true });
    }, timeoutSec * 1000);

    activeBreakpoints.set(bpId, {
      meta,
      timer,
      resolve: (decision) => {
        clearTimeout(timer);
        activeBreakpoints.delete(bpId);
        broadcastSse('breakpoint:resolved', { id: bpId, reason: decision.action || 'manual' });
        resolve(decision);
      }
    });

    broadcastSse('breakpoint:paused', meta);
  });
}

// ============================================================================
// 6. CỐT LÕI REVERSE PROXY & CHAOS PIPELINE (v2.0)
// ============================================================================

function sleepCancelable(ms, abortSignal) {
  if (!ms || ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (abortSignal.aborted) return resolve(true);
    const timer = setTimeout(() => {
      abortSignal.onAbort = null;
      resolve(false);
    }, ms);
    abortSignal.onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

function joinTargetUrl(baseTargetUrl, fullPathWithQuery) {
  const cleanBase = String(baseTargetUrl || '').trim().replace(/\/+$/, '');
  const cleanRel = String(fullPathWithQuery || '/').startsWith('/')
    ? String(fullPathWithQuery || '/')
    : '/' + String(fullPathWithQuery || '');
  return cleanBase + cleanRel;
}

function decompressBuffer(buf, encoding) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch {}
  return buf;
}

function forwardToUpstream(method, upstreamUrlStr, reqHeaders, reqBodyBuf, hopCount) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(upstreamUrlStr);
    } catch {
      return reject(new Error(`Target URL không hợp lệ: ${upstreamUrlStr}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const outHeaders = {};
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'content-length'].includes(lk)) continue;
      outHeaders[k] = v;
    }
    outHeaders['host'] = parsedUrl.host;
    outHeaders['accept-encoding'] = 'gzip, deflate, br';
    outHeaders['x-chaosforge-hop'] = String(hopCount + 1);
    if (reqBodyBuf && reqBodyBuf.length > 0) {
      outHeaders['content-length'] = Buffer.byteLength(reqBodyBuf);
    }

    const t0 = performance.now();
    const upstreamReq = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: outHeaders,
        timeout: 25000,
        rejectUnauthorized: false
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          const decodedBuf = decompressBuffer(rawBuf, upstreamRes.headers['content-encoding']);
          const cleanHeaders = {};
          for (const [hk, hv] of Object.entries(upstreamRes.headers)) {
            const lhk = hk.toLowerCase();
            if (['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(lhk)) continue;
            cleanHeaders[hk] = hv;
          }
          resolve({
            statusCode: upstreamRes.statusCode || 200,
            headers: cleanHeaders,
            bodyBuf: decodedBuf,
            upstreamMs: Math.round(performance.now() - t0)
          });
        });
      }
    );

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('UPSTREAM_TIMEOUT')));
    upstreamReq.on('error', reject);

    if (reqBodyBuf && reqBodyBuf.length > 0) upstreamReq.write(reqBodyBuf);
    upstreamReq.end();
  });
}

function applyCorsHeaders(resHeaders, reqHeaders, stripCors = false) {
  if (stripCors) {
    for (const k of Object.keys(resHeaders)) {
      if (k.toLowerCase().startsWith('access-control-')) delete resHeaders[k];
    }
    return resHeaders;
  }
  if (!store.config.corsBypass) return resHeaders;

  for (const k of Object.keys(resHeaders)) {
    if (k.toLowerCase().startsWith('access-control-')) delete resHeaders[k];
  }

  const origin = reqHeaders['origin'] || '*';
  const reqAllowedHeaders =
    reqHeaders['access-control-request-headers'] ||
    'Content-Type, Authorization, X-Requested-With, X-Idempotency-Key, Accept, Cache-Control';

  resHeaders['Access-Control-Allow-Origin'] = origin;
  resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
  resHeaders['Access-Control-Allow-Headers'] = reqAllowedHeaders;
  resHeaders['Access-Control-Expose-Headers'] = 'X-ChaosForge-Id, X-ChaosForge-Source, X-ChaosForge-Chaos, Retry-After';
  if (origin !== '*') {
    resHeaders['Access-Control-Allow-Credentials'] = 'true';
  }
  return resHeaders;
}

async function sendFinalResponse(res, statusCode, headers, bodyBuf, throttleKbps, abortState) {
  if (abortState.aborted || res.writableEnded) return 0;

  if (!throttleKbps || throttleKbps <= 0 || !bodyBuf || bodyBuf.length === 0) {
    setHeaderCaseInsensitive(headers, 'Content-Length', bodyBuf ? bodyBuf.length : 0);
    res.writeHead(statusCode, headers);
    res.end(bodyBuf);
    return 0;
  }

  const bytesPerTick = Math.max(128, Math.floor((throttleKbps * 1024) / 10));
  setHeaderCaseInsensitive(headers, 'Content-Length', bodyBuf.length);
  res.writeHead(statusCode, headers);

  const tStart = performance.now();
  let offset = 0;
  while (offset < bodyBuf.length) {
    if (abortState.aborted || res.destroyed) break;
    const end = Math.min(offset + bytesPerTick, bodyBuf.length);
    res.write(bodyBuf.subarray(offset, end));
    offset = end;
    if (offset < bodyBuf.length) {
      await sleepCancelable(100, abortState);
    }
  }
  if (!res.writableEnded && !res.destroyed) res.end();
  return Math.round(performance.now() - tStart);
}

function readRequestBodyBuffer(req, maxBytes = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (maxBytes > 0 && total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxyRequest(req, res, rawProxyUrl) {
  const hopCount = Number(req.headers['x-chaosforge-hop'] || 0);
  if (hopCount > 2) {
    res.writeHead(508, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'PROXY_LOOP_DETECTED', message: 'Phát hiện vòng lặp Proxy (x-chaosforge-hop > 2).' }));
    return;
  }

  if (req.method === 'OPTIONS' && store.config.corsBypass) {
    const preflightHeaders = applyCorsHeaders({ 'Content-Length': '0' }, req.headers, false);
    res.writeHead(204, preflightHeaders);
    res.end();
    return;
  }

  const reqStartPerf = performance.now();
  const parsedProxyUrl = new URL(rawProxyUrl, 'http://localhost');
  let method = req.method || 'GET';
  let pathname = parsedProxyUrl.pathname || '/';
  let fullPath = pathname + (parsedProxyUrl.search || '');
  const queryObj = Object.fromEntries(parsedProxyUrl.searchParams.entries());

  const abortState = { aborted: false, onAbort: null };
  res.on('close', () => {
    if (!res.writableEnded) {
      abortState.aborted = true;
      if (typeof abortState.onAbort === 'function') abortState.onAbort();
    }
  });

  const reqBodyBuf = await readRequestBodyBuffer(req);
  let reqBodyStr = reqBodyBuf.slice(0, MAX_BODY_CAPTURE).toString('utf8');
  let reqHeaders = { ...req.headers };

  const txId = 'tx-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const matchedRuleInfo = findMatchingRule(method, pathname);
  const matchedRule = matchedRuleInfo ? matchedRuleInfo.rule : null;
  const routeParams = matchedRuleInfo ? matchedRuleInfo.params : {};
  const gqlInfo = extractGraphqlInfo(pathname, reqBodyStr);

  const cfg = store.config;
  const isChaosGlobal = cfg.mode === 'CHAOS';
  const isOfflineMode = cfg.mode === 'OFFLINE_REPLAY';

  const logEntry = {
    id: txId,
    timestamp: new Date().toISOString(),
    method,
    path: pathname,
    fullPath,
    graphqlOperation: gqlInfo ? gqlInfo.operationName : null,
    targetUrl: cfg.targetUrl,
    ruleId: matchedRule ? matchedRule.id : null,
    ruleName: matchedRule ? matchedRule.name : null,
    source: 'PENDING',
    statusCode: 0,
    totalMs: 0,
    chaosDelayMs: 0,
    upstreamMs: 0,
    breakpointMs: 0,
    throttleMs: 0,
    chaosBadges: gqlInfo ? [`GQL:${gqlInfo.operationName}`] : [],
    mutationsApplied: [],
    clientAborted: false,
    reqHeaders: sanitizeHeadersForLog(reqHeaders),
    reqBody: reqBodyStr,
    resHeaders: {},
    originalResBody: '',
    resBody: ''
  };

  broadcastSse('traffic:start', {
    id: txId,
    timestamp: logEntry.timestamp,
    method,
    fullPath,
    graphqlOperation: logEntry.graphqlOperation
  });

  try {
    // ------------------------------------------------------------------------
    // STEP 0: AUTH 401 BURST & REFRESH RACE DETECTOR (v2.0)
    // ------------------------------------------------------------------------
    const refreshPattern = cfg.authChaos?.refreshPathPattern || '*/auth/refresh*';
    const isRefreshEndpoint = matchPattern(refreshPattern, pathname).matched;

    if (isRefreshEndpoint && method === 'POST') {
      const now = Date.now();
      authRuntime.recentRefreshCalls = authRuntime.recentRefreshCalls.filter((ts) => now - ts < 1600);
      authRuntime.recentRefreshCalls.push(now);

      if (authRuntime.recentRefreshCalls.length > 1) {
        authRuntime.raceIncidents++;
        logEntry.chaosBadges.push(`AUTH_REFRESH_RACE_#${authRuntime.recentRefreshCalls.length}`);
        broadcastSse('auth:race_detected', {
          incidents: authRuntime.raceIncidents,
          parallelCount: authRuntime.recentRefreshCalls.length
        });
      } else {
        authRuntime.refreshSuccessCount++;
      }
      // Clear forced 401 trap once refresh endpoint is invoked
      authRuntime.forceExpired = false;
      authRuntime.issuedTokenVersion++;
    } else if (cfg.authChaos?.enabled || authRuntime.forceExpired) {
      const hasAuthHeader = Boolean(reqHeaders['authorization']);
      const isProtectedPath = pathname.includes('/protected') || hasAuthHeader;

      if (isProtectedPath) {
        authRuntime.authedReqCounter++;
        const expireEveryN = Number(cfg.authChaos?.expireEveryN) || 0;
        if (expireEveryN > 0 && authRuntime.authedReqCounter % expireEveryN === 0) {
          authRuntime.forceExpired = true;
        }

        if (authRuntime.forceExpired) {
          const authErrBody = JSON.stringify(
            {
              ok: false,
              error: 'TOKEN_EXPIRED',
              code: 'AUTH_401_BURST_TRAP',
              message: 'Access Token đã hết hạn đột ngột (401)! Hãy dùng Refresh Mutex để lấy token mới tại /auth/refresh.'
            },
            null,
            2
          );
          const authHeaders = applyCorsHeaders(
            {
              'Content-Type': 'application/json; charset=utf-8',
              'WWW-Authenticate': 'Bearer error="invalid_token", error_description="The access token expired"',
              'X-ChaosForge-Id': txId,
              'X-ChaosForge-Chaos': 'AUTH_401_EXPIRED'
            },
            reqHeaders,
            false
          );
          logEntry.source = 'AUTH_CHAOS';
          logEntry.statusCode = 401;
          logEntry.chaosBadges.push('AUTH_401_TRAP');
          logEntry.originalResBody = authErrBody;
          logEntry.resBody = authErrBody;
          logEntry.resHeaders = authHeaders;
          await sendFinalResponse(res, 401, authHeaders, Buffer.from(authErrBody, 'utf8'), 0, abortState);
          finalizeTrafficLog(logEntry, reqStartPerf, abortState);
          return;
        }
      }
    }

    // ------------------------------------------------------------------------
    // STEP 1: LIVE REQUEST BREAKPOINT
    // ------------------------------------------------------------------------
    const shouldBreakReq =
      cfg.breakpoints.interceptRequest &&
      matchPattern(cfg.breakpoints.filterPattern || '*', pathname).matched &&
      !(matchedRule && matchedRule.action === 'BREAKPOINT');

    if (shouldBreakReq) {
      const bpStart = performance.now();
      const decision = await holdForBreakpoint('request', {
        txId,
        method,
        fullPath,
        headers: logEntry.reqHeaders,
        body: reqBodyStr
      });
      logEntry.breakpointMs += Math.round(performance.now() - bpStart);

      if (decision.action === 'drop') {
        logEntry.source = 'BREAKPOINT';
        logEntry.statusCode = 0;
        logEntry.chaosBadges.push('BP_SOCKET_DROP');
        req.socket.destroy();
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }
      if (decision.action === 'short_circuit') {
        const scStatus = Number(decision.statusCode) || 500;
        const scBody = String(decision.body ?? '{"error":"SHORT_CIRCUITED_BY_BREAKPOINT"}');
        const scHeaders = applyCorsHeaders(
          { 'Content-Type': 'application/json; charset=utf-8', 'X-ChaosForge-Id': txId },
          reqHeaders,
          false
        );
        logEntry.source = 'BREAKPOINT';
        logEntry.statusCode = scStatus;
        logEntry.chaosBadges.push('BP_SHORT_CIRCUIT');
        logEntry.originalResBody = scBody;
        logEntry.resBody = scBody;
        logEntry.resHeaders = scHeaders;
        await sendFinalResponse(res, scStatus, scHeaders, Buffer.from(scBody, 'utf8'), 0, abortState);
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }
      if (decision.method) method = String(decision.method).toUpperCase();
      if (decision.fullPath) {
        fullPath = String(decision.fullPath);
        pathname = new URL(fullPath, 'http://localhost').pathname;
      }
      if (decision.body !== undefined) {
        reqBodyStr = String(decision.body);
        logEntry.reqBody = reqBodyStr;
        logEntry.chaosBadges.push('BP_REQ_EDITED');
      }
    }

    // ------------------------------------------------------------------------
    // STEP 2: NETWORK LATENCY / JITTER / P99 SPIKE
    // ------------------------------------------------------------------------
    let delayMs = 0;
    if (matchedRule && Number(matchedRule.delayMs) > 0) {
      delayMs += Number(matchedRule.delayMs);
    } else if (isChaosGlobal || (isOfflineMode && cfg.replayApplyChaos)) {
      const base = Math.max(0, Number(cfg.chaos.latencyMs) || 0);
      const jitter = Math.max(0, Number(cfg.chaos.jitterMs) || 0);
      delayMs = base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);

      const spikeRate = Number(cfg.chaos.spikeRate) || 0;
      if (spikeRate > 0 && Math.random() * 100 < spikeRate) {
        delayMs = Math.max(delayMs, Number(cfg.chaos.spikeMs) || 3500);
        logEntry.chaosBadges.push(`SPIKE_${delayMs}ms`);
      } else if (delayMs >= 500) {
        logEntry.chaosBadges.push(`DELAY_${delayMs}ms`);
      }
    }

    if (delayMs > 0) {
      logEntry.chaosDelayMs = delayMs;
      const abortedDuringDelay = await sleepCancelable(delayMs, abortState);
      if (abortedDuringDelay) {
        logEntry.clientAborted = true;
        logEntry.source = 'CLIENT_ABORT';
        logEntry.chaosBadges.push('CLIENT_TIMEOUT_ABORT');
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }
    }

    // ------------------------------------------------------------------------
    // STEP 3: CHAOS FAULT ROLLS (DROP / HANG / HTTP ERROR %)
    // ------------------------------------------------------------------------
    const ruleAllowsChaos = !matchedRule || (matchedRule.action !== 'PASSTHROUGH' && matchedRule.action !== 'MOCK');
    const chaosActiveHere =
      (matchedRule && matchedRule.action === 'CHAOS') ||
      ((isChaosGlobal || (isOfflineMode && cfg.replayApplyChaos)) && ruleAllowsChaos);

    const stripCors =
      chaosActiveHere &&
      Number(cfg.chaos.stripCorsRate) > 0 &&
      Math.random() * 100 < Number(cfg.chaos.stripCorsRate);
    if (stripCors) logEntry.chaosBadges.push('CORS_STRIPPED');

    if (chaosActiveHere) {
      const dropRate = Number(cfg.chaos.dropRate) || 0;
      if (dropRate > 0 && Math.random() * 100 < dropRate) {
        logEntry.source = 'CHAOS_FAULT';
        logEntry.statusCode = 0;
        logEntry.chaosBadges.push('TCP_RESET');
        req.socket.destroy();
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }

      const hangRate = Number(cfg.chaos.hangRate) || 0;
      if (hangRate > 0 && Math.random() * 100 < hangRate) {
        const hangMs = Math.max(2000, Number(cfg.chaos.hangMs) || 10000);
        logEntry.source = 'CHAOS_FAULT';
        logEntry.chaosBadges.push(`HANG_${hangMs}ms`);
        logEntry.chaosDelayMs += hangMs;
        const aborted = await sleepCancelable(hangMs, abortState);
        if (aborted) {
          logEntry.clientAborted = true;
          logEntry.statusCode = 0;
          logEntry.chaosBadges.push('CLIENT_TIMEOUT_ABORT');
          finalizeTrafficLog(logEntry, reqStartPerf, abortState);
          return;
        }
        const timeoutBody = JSON.stringify({ error: 'GATEWAY_TIMEOUT_CHAOS', message: `Kết nối treo ${hangMs}ms.` }, null, 2);
        const hHeaders = applyCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'X-ChaosForge-Id': txId }, reqHeaders, stripCors);
        logEntry.statusCode = 504;
        logEntry.originalResBody = timeoutBody;
        logEntry.resBody = timeoutBody;
        logEntry.resHeaders = hHeaders;
        await sendFinalResponse(res, 504, hHeaders, Buffer.from(timeoutBody, 'utf8'), 0, abortState);
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }

      const effectiveErrorRate =
        matchedRule && matchedRule.action === 'CHAOS' && Number(matchedRule.errorRate) > 0
          ? Number(matchedRule.errorRate)
          : Number(cfg.chaos.errorRate) || 0;

      if (effectiveErrorRate > 0 && Math.random() * 100 < effectiveErrorRate) {
        let chosenStatus = 500;
        let errBody = '';

        if (matchedRule && matchedRule.action === 'CHAOS' && Number(matchedRule.errorRate) > 0) {
          chosenStatus = Number(matchedRule.statusCode) || 500;
          errBody =
            matchedRule.responseBody && matchedRule.responseBody.trim()
              ? renderDynamicTemplate(matchedRule.responseBody, {
                  method, pathname, params: routeParams, query: queryObj, reqJson: safeJsonParse(reqBodyStr)
                })
              : buildSyntheticErrorJson(chosenStatus, txId, pathname);
        } else {
          const pool = Array.isArray(cfg.chaos.errorCodes) && cfg.chaos.errorCodes.length > 0 ? cfg.chaos.errorCodes : [500, 502, 503, 429];
          chosenStatus = Number(pool[Math.floor(Math.random() * pool.length)]) || 500;
          errBody = buildSyntheticErrorJson(chosenStatus, txId, pathname);
        }

        const errHeaders = {
          'Content-Type': 'application/json; charset=utf-8',
          'X-ChaosForge-Id': txId,
          'X-ChaosForge-Source': 'CHAOS_FAULT'
        };
        if (chosenStatus === 429) errHeaders['Retry-After'] = '2';
        applyCorsHeaders(errHeaders, reqHeaders, stripCors);

        logEntry.source = 'CHAOS_FAULT';
        logEntry.statusCode = chosenStatus;
        logEntry.chaosBadges.push(`FAULT_${chosenStatus}`);
        logEntry.originalResBody = errBody;
        logEntry.resBody = errBody;
        logEntry.resHeaders = errHeaders;
        await sendFinalResponse(res, chosenStatus, errHeaders, Buffer.from(errBody, 'utf8'), cfg.chaos.throttleKbps, abortState);
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }
    }

    // ------------------------------------------------------------------------
    // STEP 3.5: SSE / AI TOKEN STREAMING FAST-PATH (v2.0)
    // ------------------------------------------------------------------------
    const wantsStream =
      !isOfflineMode &&
      !(matchedRule && matchedRule.action === 'MOCK') &&
      (isStreamRequestOrHeader(reqHeaders) || pathname.endsWith('/ai/stream'));

    if (wantsStream) {
      const fullUpstreamUrl = joinTargetUrl(cfg.targetUrl, fullPath);
      logEntry.targetUrl = fullUpstreamUrl;
      const streamRes = await proxySseUpstream({
        method,
        upstreamUrlStr: fullUpstreamUrl,
        reqHeaders,
        reqBodyBuf: Buffer.from(reqBodyStr, 'utf8'),
        hopCount,
        res,
        streamChaosCfg: chaosActiveHere ? cfg.streamChaos : { enabled: false },
        applyCorsHeaders,
        txId,
        abortState
      });
      logEntry.source = 'SSE_STREAM';
      logEntry.statusCode = streamRes.statusCode;
      logEntry.upstreamMs = streamRes.upstreamMs;
      logEntry.chaosBadges.push(...streamRes.badges);
      logEntry.resHeaders = sanitizeHeadersForLog(streamRes.headers);
      logEntry.originalResBody = streamRes.capturedBody;
      logEntry.resBody = streamRes.capturedBody;
      finalizeTrafficLog(logEntry, reqStartPerf, abortState);
      return;
    }

    // ------------------------------------------------------------------------
    // STEP 4: FULFILLMENT (MOCK vs OFFLINE CASSETTE vs UPSTREAM)
    // ------------------------------------------------------------------------
    let resStatusCode = 200;
    let resHeaders = {};
    let resBodyBuf = Buffer.alloc(0);

    if (matchedRule && matchedRule.action === 'MOCK') {
      resStatusCode = Number(matchedRule.statusCode) || 200;
      const rendered = renderDynamicTemplate(matchedRule.responseBody || '{}', {
        method, pathname, params: routeParams, query: queryObj, reqJson: safeJsonParse(reqBodyStr)
      });
      resBodyBuf = Buffer.from(rendered, 'utf8');
      resHeaders = { 'Content-Type': matchedRule.contentType || 'application/json; charset=utf-8' };
      logEntry.source = 'MOCK';
      logEntry.chaosBadges.push('MOCK_RULE');
    } else if (isOfflineMode) {
      const hit = matchCassetteEntry(cfg.activeCassetteId, method, pathname, fullPath, reqBodyStr);
      if (hit) {
        if (cfg.replayPreserveLatency && hit.entry.originalMs > 0) {
          const aborted = await sleepCancelable(hit.entry.originalMs, abortState);
          if (aborted) {
            logEntry.clientAborted = true;
            logEntry.source = 'CLIENT_ABORT';
            finalizeTrafficLog(logEntry, reqStartPerf, abortState);
            return;
          }
          logEntry.upstreamMs = hit.entry.originalMs;
        }
        resStatusCode = hit.entry.statusCode || 200;
        resHeaders = { ...(hit.entry.headers || {}) };
        resBodyBuf = Buffer.from(hit.entry.resBody || '', 'utf8');
        logEntry.source = 'CASSETTE_REPLAY';
        logEntry.chaosBadges.push(hit.sequenceTotal > 1 ? `REPLAY_${hit.sequenceIndex}/${hit.sequenceTotal}` : 'OFFLINE_REPLAY');
      } else {
        resStatusCode = 404;
        const missJson = JSON.stringify(
          {
            error: 'CASSETTE_MISS',
            message: `Không tìm thấy bản ghi Offline cho [${method} ${fullPath}] trong '${cfg.activeCassetteId}'.`
          },
          null,
          2
        );
        resBodyBuf = Buffer.from(missJson, 'utf8');
        resHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
        logEntry.source = 'CASSETTE_MISS';
        logEntry.chaosBadges.push('CASSETTE_MISS');
      }
    } else {
      const fullUpstreamUrl = joinTargetUrl(cfg.targetUrl, fullPath);
      logEntry.targetUrl = fullUpstreamUrl;
      try {
        const upRes = await forwardToUpstream(method, fullUpstreamUrl, reqHeaders, Buffer.from(reqBodyStr, 'utf8'), hopCount);
        resStatusCode = upRes.statusCode;
        resHeaders = upRes.headers;
        resBodyBuf = upRes.bodyBuf;
        logEntry.upstreamMs = upRes.upstreamMs;
        logEntry.source = 'UPSTREAM';
      } catch (upErr) {
        if (cfg.autoFallbackOffline) {
          const fallbackHit = matchCassetteEntry(cfg.activeCassetteId, method, pathname, fullPath, reqBodyStr);
          if (fallbackHit) {
            resStatusCode = fallbackHit.entry.statusCode || 200;
            resHeaders = { ...(fallbackHit.entry.headers || {}) };
            resBodyBuf = Buffer.from(fallbackHit.entry.resBody || '', 'utf8');
            logEntry.source = 'CASSETTE_REPLAY';
            logEntry.chaosBadges.push('AUTO_OFFLINE_FALLBACK');
          } else {
            resStatusCode = 502;
            resHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
            resBodyBuf = Buffer.from(JSON.stringify({ error: 'BAD_GATEWAY_UPSTREAM_DOWN', reason: upErr.message }, null, 2), 'utf8');
            logEntry.source = 'UPSTREAM_ERR';
          }
        } else {
          resStatusCode = 502;
          resHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
          resBodyBuf = Buffer.from(
            JSON.stringify({ error: 'BAD_GATEWAY_UPSTREAM_UNREACHABLE', upstream: fullUpstreamUrl, reason: upErr.message }, null, 2),
            'utf8'
          );
          logEntry.source = 'UPSTREAM_ERR';
          logEntry.chaosBadges.push('UPSTREAM_ERR');
        }
      }
    }

    let originalResStr = resBodyBuf.slice(0, MAX_BODY_CAPTURE).toString('utf8');
    logEntry.originalResBody = originalResStr;

    // ------------------------------------------------------------------------
    // STEP 5: CASSETTE RECORDING
    // ------------------------------------------------------------------------
    if (cfg.recording && (logEntry.source === 'UPSTREAM' || logEntry.source === 'MOCK')) {
      recordToActiveCassette({
        method, path: pathname, fullPath, reqBody: reqBodyStr,
        statusCode: resStatusCode, upstreamMs: logEntry.upstreamMs,
        headers: resHeaders, resBody: originalResStr
      });
      logEntry.chaosBadges.push('RECORDED');
    }

    // ------------------------------------------------------------------------
    // STEP 6: GRAPHQL CHAOS & WIRE JSON MUTATOR
    // ------------------------------------------------------------------------
    let finalBodyStr = originalResStr;
    let contentType = getHeaderCaseInsensitive(resHeaders, 'content-type') || 'application/json; charset=utf-8';

    if (chaosActiveHere && gqlInfo && cfg.graphqlChaos?.enabled) {
      const gqlMut = applyGraphqlChaos(finalBodyStr, gqlInfo, cfg.graphqlChaos);
      if (gqlMut && gqlMut.mutated) {
        finalBodyStr = gqlMut.body;
        resBodyBuf = Buffer.from(finalBodyStr, 'utf8');
        logEntry.mutationsApplied.push(gqlMut.badge);
        logEntry.chaosBadges.push(gqlMut.badge);
      }
    }

    const ruleMutator = matchedRule && matchedRule.mutatorOverride ? matchedRule.mutatorOverride : null;
    const shouldRunMutator =
      ruleMutator ||
      (chaosActiveHere && cfg.mutator.enabled && Math.random() * 100 < (Number(cfg.mutator.mutationRate) || 100));

    if (shouldRunMutator) {
      const mergedMutator = ruleMutator ? { ...cfg.mutator, ...ruleMutator, enabled: true } : cfg.mutator;
      const mutResult = applyJsonMutations(finalBodyStr, contentType, mergedMutator);
      if (mutResult.mutated) {
        finalBodyStr = mutResult.body;
        contentType = mutResult.newContentType;
        setHeaderCaseInsensitive(resHeaders, 'Content-Type', contentType);
        resBodyBuf = Buffer.from(finalBodyStr, 'utf8');
        logEntry.mutationsApplied.push(...mutResult.applied);
        logEntry.chaosBadges.push('JSON_MUTATED');
      }
    }

    // ------------------------------------------------------------------------
    // STEP 7: LIVE RESPONSE BREAKPOINT
    // ------------------------------------------------------------------------
    const shouldBreakRes =
      (cfg.breakpoints.interceptResponse && matchPattern(cfg.breakpoints.filterPattern || '*', pathname).matched) ||
      (matchedRule && matchedRule.action === 'BREAKPOINT');

    if (shouldBreakRes) {
      const bpStart = performance.now();
      const decision = await holdForBreakpoint('response', {
        txId, method, fullPath, statusCode: resStatusCode, headers: resHeaders,
        originalBody: originalResStr, body: finalBodyStr
      });
      logEntry.breakpointMs += Math.round(performance.now() - bpStart);

      if (decision.action === 'drop') {
        logEntry.chaosBadges.push('BP_SOCKET_DROP');
        logEntry.statusCode = 0;
        req.socket.destroy();
        finalizeTrafficLog(logEntry, reqStartPerf, abortState);
        return;
      }
      if (decision.statusCode !== undefined) resStatusCode = Number(decision.statusCode) || resStatusCode;
      if (decision.contentType) setHeaderCaseInsensitive(resHeaders, 'Content-Type', decision.contentType);
      if (decision.body !== undefined && decision.body !== finalBodyStr) {
        finalBodyStr = String(decision.body);
        resBodyBuf = Buffer.from(finalBodyStr, 'utf8');
        logEntry.mutationsApplied.push('LIVE_SURGEON_EDIT');
        logEntry.chaosBadges.push('BP_EDITED');
      } else if (!decision.timedOut) {
        logEntry.chaosBadges.push('BP_RESUMED');
      }
    }

    // ------------------------------------------------------------------------
    // STEP 8: SEND FINAL RESPONSE
    // ------------------------------------------------------------------------
    resHeaders['X-ChaosForge-Id'] = txId;
    resHeaders['X-ChaosForge-Source'] = logEntry.source;
    if (logEntry.chaosBadges.length > 0) {
      resHeaders['X-ChaosForge-Chaos'] = logEntry.chaosBadges.join(',');
    }
    applyCorsHeaders(resHeaders, reqHeaders, stripCors);

    const throttleKbps = chaosActiveHere ? Number(cfg.chaos.throttleKbps) || 0 : 0;
    if (throttleKbps > 0) logEntry.chaosBadges.push(`THROTTLE_${throttleKbps}KBps`);

    logEntry.statusCode = resStatusCode;
    logEntry.resHeaders = sanitizeHeadersForLog(resHeaders);
    logEntry.resBody = finalBodyStr;

    logEntry.throttleMs = await sendFinalResponse(res, resStatusCode, resHeaders, resBodyBuf, throttleKbps, abortState);
    finalizeTrafficLog(logEntry, reqStartPerf, abortState);
  } catch (fatalErr) {
    console.error('[Proxy Fatal]', fatalErr);
    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'CHAOSFORGE_INTERNAL_ERROR', message: fatalErr.message }));
    }
    logEntry.statusCode = 500;
    logEntry.source = 'PROXY_ERR';
    finalizeTrafficLog(logEntry, reqStartPerf, abortState);
  }
}

function buildSyntheticErrorJson(statusCode, txId, pathname) {
  const catalog = {
    400: { code: 'BAD_REQUEST', message: 'Yêu cầu không hợp lệ (Chaos Injected 400).' },
    401: { code: 'TOKEN_EXPIRED', message: 'Phiên đăng nhập hết hạn đột ngột (401).' },
    403: { code: 'FORBIDDEN_ACCESS', message: 'Không đủ quyền truy cập tài nguyên này (403).' },
    404: { code: 'RESOURCE_NOT_FOUND', message: `Không tìm thấy endpoint ${pathname} (Chaos 404).` },
    429: { code: 'RATE_LIMIT_EXCEEDED', message: 'Quá giới hạn tần suất gọi API (429 Too Many Requests). Thử lại sau 2s!' },
    500: { code: 'INTERNAL_SERVER_ERROR', message: 'Lỗi máy chủ nội bộ 500 (Database Pool Exhausted — ChaosForge).' },
    502: { code: 'BAD_GATEWAY', message: '502 Bad Gateway — Upstream Worker bị ngắt đột ngột.' },
    503: { code: 'SERVICE_UNAVAILABLE', message: '503 Hệ thống đang quá tải hoặc bảo trì khẩn cấp.' },
    504: { code: 'GATEWAY_TIMEOUT', message: '504 Gateway Timeout — Dịch vụ đích phản hồi quá thời gian cho phép.' }
  };
  const info = catalog[statusCode] || { code: `HTTP_${statusCode}`, message: `Lỗi giả lập HTTP ${statusCode}` };
  return JSON.stringify({ ok: false, error: info.code, statusCode, message: info.message, chaosForgeTxId: txId }, null, 2);
}

function finalizeTrafficLog(entry, reqStartPerf, abortState) {
  if (abortState.aborted) {
    entry.clientAborted = true;
    if (!entry.chaosBadges.includes('CLIENT_TIMEOUT_ABORT')) entry.chaosBadges.push('CLIENT_ABORTED');
  }
  entry.totalMs = Math.round(performance.now() - reqStartPerf);
  trafficLogs.unshift(entry);
  if (trafficLogs.length > MAX_TRAFFIC_LOGS) trafficLogs.pop();
  broadcastSse('traffic:done', entry);
}

function computeTelemetrySummary() {
  const total = trafficLogs.length;
  const wsActive = getActiveWsList().length;
  if (total === 0) {
    return {
      totalRequests: 0, errorCount: 0, errorRatePct: 0, mutatedCount: 0, replayedCount: 0,
      clientAbortedCount: 0, avgLatencyMs: 0, p95LatencyMs: 0,
      doubleSubmitIncidents: demoBackendState.doubleSubmitIncidents,
      authRaceIncidents: authRuntime.raceIncidents,
      activeWsCount: wsActive
    };
  }
  let errCount = 0;
  let mutatedCount = 0;
  let replayedCount = 0;
  let abortedCount = 0;
  const latencies = [];

  for (const t of trafficLogs) {
    if (t.statusCode >= 400 || t.statusCode === 0) errCount++;
    if (t.mutationsApplied && t.mutationsApplied.length > 0) mutatedCount++;
    if (t.source === 'CASSETTE_REPLAY') replayedCount++;
    if (t.clientAborted) abortedCount++;
    latencies.push(t.totalMs || 0);
  }
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);
  const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));

  return {
    totalRequests: total,
    errorCount: errCount,
    errorRatePct: Math.round((errCount / total) * 100),
    mutatedCount,
    replayedCount,
    clientAbortedCount: abortedCount,
    avgLatencyMs: Math.round(sum / total),
    p95LatencyMs: latencies[p95Idx] || 0,
    doubleSubmitIncidents: demoBackendState.doubleSubmitIncidents,
    authRaceIncidents: authRuntime.raceIncidents,
    activeWsCount: wsActive
  };
}

// ============================================================================
// 7. BUILT-IN DEMO UPSTREAM (/demo-api/*): REST + AI SSE + AUTH + GRAPHQL
// ============================================================================

async function handleDemoBackend(req, res, subPathWithQuery) {
  const u = new URL(subPathWithQuery, 'http://localhost');
  const p = u.pathname;

  // 1. AI Token Streaming Endpoint (SSE)
  if (p === '/ai/stream') {
    let prompt = u.searchParams.get('prompt') || '';
    if (req.method === 'POST') {
      const b = await readRequestBodyBuffer(req);
      const j = safeJsonParse(b.toString('utf8'));
      if (j && j.prompt) prompt = String(j.prompt);
    }
    return await handleDemoAiStream(req, res, prompt);
  }

  // 2. Auth Refresh Endpoint (with 160ms realistic delay so parallel refresh calls overlap!)
  if (req.method === 'POST' && p === '/auth/refresh') {
    await new Promise((r) => setTimeout(r, 160));
    const newToken = `eyJ_demo_token_v${authRuntime.issuedTokenVersion}_${Date.now().toString(36)}`;
    return sendJson(res, 200, {
      ok: true,
      accessToken: newToken,
      expiresIn: 3600,
      raceIncidents: authRuntime.raceIncidents
    });
  }

  // 3. Protected Endpoint for 401 Burst Testing
  if (req.method === 'GET' && p === '/protected/widget') {
    const slot = u.searchParams.get('slot') || '1';
    return sendJson(res, 200, {
      ok: true,
      slot,
      secretMetric: `Dữ liệu bảo mật Widget #${slot} (Token hợp lệ)`,
      tokenUsed: (req.headers['authorization'] || 'none').slice(0, 32)
    });
  }

  // 4. Built-in GraphQL Endpoint
  if (req.method === 'POST' && p === '/graphql') {
    const buf = await readRequestBodyBuffer(req);
    const body = safeJsonParse(buf.toString('utf8')) || {};
    return sendJson(res, 200, {
      data: {
        wallet: {
          owner: 'Minh Trần',
          balance: demoBackendState.walletBalance,
          currency: 'VND'
        },
        featuredProducts: [
          { id: 'sku_keychron', name: 'Keychron Q1 Pro Wireless', price: 4290000 },
          { id: 'sku_sony_xm5', name: 'Sony WH-1000XM5', price: 6490000 }
        ],
        operationEcho: body.operationName || 'Query'
      }
    });
  }

  if (req.method === 'GET' && p === '/dashboard/summary') {
    return sendJson(res, 200, {
      ok: true,
      source: 'PayFlow Live Demo Backend v2.0',
      user: { id: 'usr_9901', name: 'Minh Trần', tier: 'PLATINUM', avatar: '🧑‍💻' },
      wallet: { balance: demoBackendState.walletBalance, currency: 'VND', pendingCashback: 420000 },
      ordersCount: demoBackendState.orders.length,
      doubleSubmitIncidents: demoBackendState.doubleSubmitIncidents
    });
  }

  if (req.method === 'GET' && p === '/products') {
    return sendJson(res, 200, {
      ok: true,
      updatedAt: new Date().toISOString(),
      products: [
        { id: 'sku_keychron', name: 'Bàn phím cơ Keychron Q1 Pro Wireless', price: 4290000, stock: 8, badge: 'FLASH SALE' },
        { id: 'sku_sony_xm5', name: 'Tai nghe chống ồn Sony WH-1000XM5', price: 6490000, stock: 3, badge: 'SẮP HẾT' },
        { id: 'sku_ssd_2tb', name: 'Ổ cứng NVMe Samsung 990 PRO 2TB', price: 3850000, stock: 19, badge: 'BÁN CHẠY' },
        { id: 'sku_dock_tb4', name: 'Thunderbolt 4 Dock 12-in-1 Dual 4K', price: 5190000, stock: 5, badge: 'MỚI' }
      ]
    });
  }

  if (req.method === 'GET' && p === '/orders/track') {
    const stages = [
      { step: 1, status: 'PACKING', statusLabel: 'Đang đóng gói tại kho Quận 7', progressPct: 35 },
      { step: 2, status: 'IN_TRANSIT', statusLabel: 'Tài xế đang giao hàng (cách 1.8km)', progressPct: 75 },
      { step: 3, status: 'DELIVERED', statusLabel: 'Giao thành công — Đã ký nhận!', progressPct: 100 }
    ];
    const current = stages[demoBackendState.trackStep % stages.length];
    demoBackendState.trackStep++;
    return sendJson(res, 200, { ok: true, orderId: 'ORD-2026-881', ...current, timestamp: new Date().toISOString() });
  }

  if (req.method === 'POST' && p === '/checkout') {
    const buf = await readRequestBodyBuffer(req);
    const body = safeJsonParse(buf.toString('utf8')) || {};
    const idemKey = req.headers['x-idempotency-key'] || body.idempotencyKey || '';
    const amount = Number(body.amount) || 4290000;
    const itemName = body.itemName || 'Keychron Q1 Pro Wireless';

    if (idemKey && demoBackendState.seenIdempotencyKeys.has(idemKey)) {
      const existingOrder = demoBackendState.seenIdempotencyKeys.get(idemKey);
      return sendJson(res, 200, {
        ok: true,
        idempotentReplay: true,
        order: existingOrder,
        walletBalance: demoBackendState.walletBalance,
        message: 'Idempotency Key bảo vệ thành công: Không trừ tiền trùng lặp!'
      });
    }

    const now = Date.now();
    demoBackendState.recentRawCheckouts = demoBackendState.recentRawCheckouts.filter((t) => now - t.ts < 8000);
    let duplicateWarning = null;
    if (!idemKey && demoBackendState.recentRawCheckouts.some((t) => t.itemName === itemName)) {
      demoBackendState.doubleSubmitIncidents++;
      duplicateWarning = `PHÁT HIỆN DOUBLE-SUBMIT! Ví bị trừ tiền lặp lại (${demoBackendState.doubleSubmitIncidents} lần vi phạm)!`;
      broadcastSse('demo:double_submit', { incidents: demoBackendState.doubleSubmitIncidents, itemName, amount });
    }
    demoBackendState.recentRawCheckouts.push({ ts: now, itemName });

    demoBackendState.walletBalance -= amount;
    const newOrder = {
      orderId: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
      itemName,
      chargedAmount: amount,
      createdAt: new Date().toISOString(),
      duplicateBugTriggered: Boolean(duplicateWarning)
    };
    demoBackendState.orders.unshift(newOrder);
    if (idemKey) demoBackendState.seenIdempotencyKeys.set(idemKey, newOrder);

    return sendJson(res, 200, {
      ok: true,
      idempotentReplay: false,
      order: newOrder,
      walletBalance: demoBackendState.walletBalance,
      duplicateWarning,
      message: duplicateWarning || 'Đặt hàng & thanh toán thành công!'
    });
  }

  return sendJson(res, 404, { ok: false, error: 'DEMO_ENDPOINT_NOT_FOUND', path: p });
}

// ============================================================================
// 8. CONTROL REST API (PORT 4190)
// ============================================================================

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function handleControlApi(req, res, parsedUrl) {
  // Handle CORS Preflight on Control API so Floating HUD (/chaos-hud.js) works from ANY host port!
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const p = parsedUrl.pathname;

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, proxyPort: PROXY_PORT })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      ok: true,
      ports: { cockpit: PORT, proxy: PROXY_PORT },
      config: store.config,
      presets: CHAOS_PRESETS,
      rules: store.rules,
      cassettes: listCassettesMeta(),
      breakpoints: Array.from(activeBreakpoints.values()).map((b) => b.meta),
      telemetry: computeTelemetrySummary(),
      authState: {
        forceExpired: authRuntime.forceExpired,
        raceIncidents: authRuntime.raceIncidents,
        refreshSuccessCount: authRuntime.refreshSuccessCount
      },
      wsConnections: getActiveWsList(),
      timeline: timelineRunner.getStatus(),
      traffic: trafficLogs.slice(0, 80)
    });
  }

  if (req.method === 'POST' && p === '/api/config') {
    const body = await readJsonBody(req);
    mergeConfigPatch(body);
    saveStore();
    broadcastSse('state:updated', { config: store.config });
    return sendJson(res, 200, { ok: true, config: store.config });
  }

  if (req.method === 'POST' && p === '/api/preset') {
    const body = await readJsonBody(req);
    const preset = CHAOS_PRESETS[body.presetId];
    if (!preset) return sendJson(res, 400, { ok: false, error: 'Preset không tồn tại' });
    store.config.activePreset = preset.id;
    mergeConfigPatch(preset);
    saveStore();
    broadcastSse('state:updated', { config: store.config });
    return sendJson(res, 200, { ok: true, config: store.config, preset });
  }

  // Auth 401 Burst Trigger
  if (req.method === 'POST' && p === '/api/auth-chaos/expire-now') {
    authRuntime.forceExpired = true;
    authRuntime.recentRefreshCalls = [];
    store.config.authChaos.enabled = true;
    saveStore();
    broadcastSse('auth:expired_armed', { forceExpired: true });
    return sendJson(res, 200, { ok: true, forceExpired: true, raceIncidents: authRuntime.raceIncidents });
  }

  // WebSocket Chaos Control
  if (req.method === 'GET' && p === '/api/ws') {
    return sendJson(res, 200, { ok: true, connections: getActiveWsList() });
  }

  if (req.method === 'POST' && p === '/api/ws/kill-all') {
    const killed = killAllWebSockets();
    broadcastSse('ws:killed_all', { killed });
    return sendJson(res, 200, { ok: true, killed });
  }

  // Timeline Storyboard API
  if (req.method === 'GET' && p === '/api/timeline') {
    return sendJson(res, 200, { ok: true, ...timelineRunner.getStatus() });
  }

  if (req.method === 'POST' && p === '/api/timeline/start') {
    const body = await readJsonBody(req);
    try {
      const run = timelineRunner.start(body.templateId || body.customTimeline);
      return sendJson(res, 200, { ok: true, run });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && p === '/api/timeline/stop') {
    const completed = timelineRunner.stop('manual_stop');
    return sendJson(res, 200, { ok: true, completed });
  }

  // Markdown Resilience Audit Report
  if (req.method === 'GET' && p === '/api/report/markdown') {
    const md = generateMarkdownAuditReport({
      trafficLogs,
      telemetry: computeTelemetrySummary(),
      authStats: authRuntime,
      timelineRun: timelineRunner.activeRun || timelineRunner.lastCompletedRun,
      targetUrl: store.config.targetUrl
    });
    return sendJson(res, 200, { ok: true, markdown: md });
  }

  // HAR Import / Export & Auto-OpenAPI 3.0 Harvester
  if (req.method === 'POST' && p === '/api/har/import') {
    try {
      const buf = await readRequestBodyBuffer(req, MAX_HAR_BODY_BYTES);
      const body = JSON.parse(buf.toString('utf8'));
      const harObj = body.har || body;
      const result = importHarToCassette(harObj, body.name);
      const casId = 'cas-har-' + Date.now().toString(36);
      const saved = writeCassette({
        id: casId,
        name: result.name,
        description: `Nhập từ Chrome HAR (${result.detectedOrigins.join(', ') || 'API'})`,
        entries: result.entries
      });
      if (body.activate !== false) {
        store.config.activeCassetteId = saved.id;
        saveStore();
        broadcastSse('state:updated', { config: store.config });
      }
      return sendJson(res, 201, {
        ok: true,
        cassette: saved,
        importedCount: result.entries.length,
        detectedOrigins: result.detectedOrigins,
        cassettes: listCassettesMeta()
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && p === '/api/har/export') {
    const source = parsedUrl.searchParams.get('source') || 'traffic';
    let list = trafficLogs;
    if (source === 'cassette') {
      const cas = readCassette(store.config.activeCassetteId);
      list = cas ? cas.entries : [];
    }
    const har = exportToHar(list, `http://localhost:${PROXY_PORT}`);
    return sendJson(res, 200, har);
  }

  if (req.method === 'GET' && p === '/api/openapi') {
    const cas = readCassette(store.config.activeCassetteId);
    const harvested = harvestOpenApiSpec({
      trafficLogs,
      cassetteEntries: cas ? cas.entries : [],
      targetUrl: store.config.targetUrl
    });
    return sendJson(res, 200, { ok: true, ...harvested });
  }

  // Traffic Logs & Replay
  if (req.method === 'GET' && p === '/api/traffic') {
    return sendJson(res, 200, { ok: true, telemetry: computeTelemetrySummary(), traffic: trafficLogs });
  }

  if (req.method === 'DELETE' && p === '/api/traffic') {
    trafficLogs.length = 0;
    broadcastSse('traffic:cleared', {});
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/replay-request') {
    const body = await readJsonBody(req);
    const method = String(body.method || 'GET').toUpperCase();
    const fullPath = String(body.fullPath || '/');
    const reqBody = body.reqBody ? Buffer.from(String(body.reqBody), 'utf8') : null;
    const headers = {};
    if (body.headers && typeof body.headers === 'object') {
      for (const [k, v] of Object.entries(body.headers)) {
        if (!['host', 'content-length', 'connection'].includes(k.toLowerCase())) headers[k] = v;
      }
    }
    try {
      const replayRes = await forwardToUpstream(
        method,
        `http://127.0.0.1:${PROXY_PORT}${fullPath.startsWith('/') ? fullPath : '/' + fullPath}`,
        headers,
        reqBody,
        0
      );
      return sendJson(res, 200, { ok: true, statusCode: replayRes.statusCode, durationMs: replayRes.upstreamMs, body: replayRes.bodyBuf.toString('utf8') });
    } catch (err) {
      return sendJson(res, 200, { ok: false, networkError: true, message: err.message });
    }
  }

  // Rules CRUD
  if (req.method === 'GET' && p === '/api/rules') return sendJson(res, 200, { ok: true, rules: store.rules });

  if (req.method === 'POST' && p === '/api/rules') {
    const body = await readJsonBody(req);
    const newRule = {
      id: 'rule-' + crypto.randomBytes(4).toString('hex'),
      name: String(body.name || 'Luật Can Thiệp Mới'),
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
      method: String(body.method || 'ALL').toUpperCase(),
      pathPattern: String(body.pathPattern || '/*').trim(),
      action: body.action || 'MOCK',
      delayMs: Math.max(0, Number(body.delayMs) || 0),
      errorRate: Math.max(0, Math.min(100, Number(body.errorRate) || 0)),
      statusCode: Number(body.statusCode) || 200,
      contentType: String(body.contentType || 'application/json; charset=utf-8'),
      responseBody: body.responseBody !== undefined ? String(body.responseBody) : '{"ok": true}',
      mutatorOverride: body.mutatorOverride || null
    };
    store.rules.unshift(newRule);
    saveStore();
    broadcastSse('state:updated', { rules: store.rules });
    return sendJson(res, 201, { ok: true, rule: newRule, rules: store.rules });
  }

  if (p.startsWith('/api/rules/')) {
    const ruleId = decodeURIComponent(p.slice('/api/rules/'.length));
    const idx = store.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: 'Không tìm thấy Rule' });

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      store.rules[idx] = { ...store.rules[idx], ...body, id: ruleId };
      saveStore();
      broadcastSse('state:updated', { rules: store.rules });
      return sendJson(res, 200, { ok: true, rule: store.rules[idx], rules: store.rules });
    }
    if (req.method === 'DELETE') {
      store.rules.splice(idx, 1);
      saveStore();
      broadcastSse('state:updated', { rules: store.rules });
      return sendJson(res, 200, { ok: true, rules: store.rules });
    }
  }

  // Cassettes CRUD
  if (req.method === 'GET' && p === '/api/cassettes') return sendJson(res, 200, { ok: true, cassettes: listCassettesMeta() });

  if (req.method === 'POST' && p === '/api/cassettes') {
    const body = await readJsonBody(req);
    const id = body.id && String(body.id).trim() ? String(body.id).replace(/[^a-zA-Z0-9_-]/g, '') : 'cas-' + Date.now().toString(36);
    const cassette = writeCassette({
      id,
      name: String(body.name || `Cuộn Băng ${new Date().toLocaleString('vi-VN')}`),
      description: String(body.description || ''),
      entries: Array.isArray(body.entries) ? body.entries : []
    });
    if (body.activate) {
      store.config.activeCassetteId = cassette.id;
      if (body.startRecording) store.config.recording = true;
      saveStore();
      broadcastSse('state:updated', { config: store.config });
    }
    return sendJson(res, 201, { ok: true, cassette, cassettes: listCassettesMeta() });
  }

  if (p.startsWith('/api/cassettes/')) {
    const parts = p.slice('/api/cassettes/'.length).split('/');
    const casId = decodeURIComponent(parts[0]);

    if (req.method === 'POST' && parts[1] === 'reset-cursors') {
      for (const k of cassetteSequenceCursors.keys()) {
        if (k.startsWith(`${casId}:`)) cassetteSequenceCursors.delete(k);
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const cas = readCassette(casId);
      if (!cas) return sendJson(res, 404, { ok: false, error: 'Không tìm thấy Cassette' });
      return sendJson(res, 200, { ok: true, cassette: cas });
    }
    if (req.method === 'PUT') {
      const existing = readCassette(casId);
      if (!existing) return sendJson(res, 404, { ok: false, error: 'Không tìm thấy Cassette' });
      const body = await readJsonBody(req);
      const updated = writeCassette({
        ...existing,
        name: body.name !== undefined ? String(body.name) : existing.name,
        description: body.description !== undefined ? String(body.description) : existing.description,
        entries: Array.isArray(body.entries) ? body.entries : existing.entries
      });
      return sendJson(res, 200, { ok: true, cassette: updated, cassettes: listCassettesMeta() });
    }
    if (req.method === 'DELETE') {
      const safeId = casId.replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(CASSETTES_DIR, `${safeId}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return sendJson(res, 200, { ok: true, cassettes: listCassettesMeta() });
    }
  }

  // Breakpoints
  if (req.method === 'GET' && p === '/api/breakpoints') {
    return sendJson(res, 200, { ok: true, breakpoints: Array.from(activeBreakpoints.values()).map((b) => b.meta) });
  }

  if (req.method === 'POST' && p.startsWith('/api/breakpoints/') && p.endsWith('/resolve')) {
    const bpId = decodeURIComponent(p.slice('/api/breakpoints/'.length, -'/resolve'.length));
    const bp = activeBreakpoints.get(bpId);
    if (!bp) return sendJson(res, 404, { ok: false, error: 'Gói tin đã hết hạn hoặc đã phóng đi.' });
    const body = await readJsonBody(req);
    bp.resolve(body || { action: 'resume' });
    return sendJson(res, 200, { ok: true });
  }

  // Reset Demo Store & Auth Stats
  if (req.method === 'POST' && p === '/api/demo/reset') {
    demoBackendState.walletBalance = 18500000;
    demoBackendState.orders = [];
    demoBackendState.seenIdempotencyKeys.clear();
    demoBackendState.recentRawCheckouts = [];
    demoBackendState.doubleSubmitIncidents = 0;
    demoBackendState.trackStep = 0;
    authRuntime.forceExpired = false;
    authRuntime.raceIncidents = 0;
    authRuntime.recentRefreshCalls = [];
    cassetteSequenceCursors.clear();
    return sendJson(res, 200, { ok: true, demoBackendState });
  }

  return sendJson(res, 404, { ok: false, error: 'API_NOT_FOUND' });
}

// ============================================================================
// 9. TIỆN ÍCH HTTP & STATIC SERVING
// ============================================================================

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStaticFile(req, res, pathname) {
  const relPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(safePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(safePath).pipe(res);
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const buf = await readRequestBodyBuffer(req);
  if (!buf || buf.length === 0) return {};
  return safeJsonParse(buf.toString('utf8')) || {};
}

function safeJsonParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getHeaderCaseInsensitive(headers, name) {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function setHeaderCaseInsensitive(headers, name, value) {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) delete headers[k];
  }
  headers[name] = value;
}

function sanitizeHeadersForLog(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

// ============================================================================
// 10. KHỞI ĐỘNG COCKPIT (:4190) & CHAOS PROXY GATEWAY (:4191 HTTP + WS)
// ============================================================================

const cockpitServer = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) return await handleControlApi(req, res, parsedUrl);
    if (pathname === '/demo-api' || pathname.startsWith('/demo-api/')) {
      const subPath = (pathname.slice('/demo-api'.length) || '/') + parsedUrl.search;
      return await handleDemoBackend(req, res, subPath);
    }
    if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
      const subPath = (pathname.slice('/proxy'.length) || '/') + parsedUrl.search;
      return await handleProxyRequest(req, res, subPath);
    }
    return serveStaticFile(req, res, pathname);
  } catch (err) {
    console.error('[Cockpit Error]', err);
    if (!res.writableEnded) sendJson(res, 500, { ok: false, error: err.message });
  }
});

// Built-in RFC 6455 WebSocket Demo Endpoint at ws://localhost:4190/demo-api/ws
cockpitServer.on('upgrade', (req, socket) => {
  if ((req.url || '').startsWith('/demo-api/ws')) {
    handleDemoWsUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

const proxyGatewayServer = http.createServer(async (req, res) => {
  await handleProxyRequest(req, res, req.url || '/');
});

// Transparent WebSocket Chaos Tunnel on ws://localhost:4191/*
proxyGatewayServer.on('upgrade', (req, clientSocket, head) => {
  handleProxyWsUpgrade(
    req,
    clientSocket,
    head,
    () => store.config,
    (evName, payload) => broadcastSse(evName, payload)
  );
});

cockpitServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ ChaosForge v2.0 Cockpit UI tại       : http://localhost:${PORT}`);
  console.log(`💉 Floating HUD Script nhúng 1 dòng    : <script src="http://localhost:${PORT}/chaos-hud.js"></script>`);
});

proxyGatewayServer.on('error', (err) => {
  console.warn(`⚠️ Cổng Proxy phụ ${PROXY_PORT} đang bận (${err.code}).`);
});

proxyGatewayServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`🛡️  Chaos HTTP + SSE + WS Proxy tại     : http://localhost:${PROXY_PORT} (ws://localhost:${PROXY_PORT})`);
  console.log(`🎯 Upstream Đích hiện tại              : ${store.config.targetUrl}\n`);
});
