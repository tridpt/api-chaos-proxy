/**
 * 📦 ChaosForge v2.0 — Chrome DevTools .HAR Importer/Exporter & Auto-OpenAPI 3.0 Harvester
 */

const crypto = require('node:crypto');
const { URL } = require('node:url');

const STATIC_EXT_RE = /\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i;
const SKIP_MIME_PREFIXES = ['image/', 'font/', 'video/', 'audio/', 'text/css', 'application/javascript', 'text/javascript'];

function hashStr(str) {
  if (!str) return '';
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 12);
}

// ============================================================================
// 1. IMPORT .HAR (HTTP ARCHIVE v1.2) -> CASSETTE ENTRIES
// ============================================================================

function importHarToCassette(harJson, customName = '') {
  const rawEntries = harJson?.log?.entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error('Tệp .HAR không hợp lệ: thiếu mảng log.entries[]');
  }

  const entries = [];
  const detectedOrigins = new Set();

  for (const item of rawEntries) {
    const req = item?.request;
    const res = item?.response;
    if (!req || !res || !req.url) continue;

    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    if (STATIC_EXT_RE.test(parsedUrl.pathname)) continue;

    const mime = String(res.content?.mimeType || '').toLowerCase();
    if (SKIP_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) continue;

    detectedOrigins.add(parsedUrl.origin);

    let resBody = '';
    if (res.content && typeof res.content.text === 'string') {
      if (res.content.encoding === 'base64') {
        try {
          resBody = Buffer.from(res.content.text, 'base64').toString('utf8');
        } catch {
          resBody = res.content.text;
        }
      } else {
        resBody = res.content.text;
      }
    }

    const reqBody = req.postData?.text || '';
    const headers = {};
    if (Array.isArray(res.headers)) {
      for (const h of res.headers) {
        if (!h || !h.name) continue;
        const lk = h.name.toLowerCase();
        if (['content-type', 'cache-control', 'retry-after'].includes(lk) || lk.startsWith('x-')) {
          headers[lk] = h.value;
        }
      }
    }
    if (!headers['content-type']) {
      headers['content-type'] = res.content?.mimeType || 'application/json; charset=utf-8';
    }

    entries.push({
      id: 'har-' + crypto.randomBytes(4).toString('hex'),
      recordedAt: item.startedDateTime || new Date().toISOString(),
      method,
      path: parsedUrl.pathname || '/',
      fullPath: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
      reqBodyHash: hashStr(reqBody),
      reqBodySample: reqBody.slice(0, 1024),
      statusCode: Number(res.status) || 200,
      originalMs: Math.max(1, Math.round(Number(item.time) || 30)),
      headers,
      resBody
    });
  }

  return {
    name: customName || `HAR Import (${entries.length} API calls)`,
    detectedOrigins: Array.from(detectedOrigins),
    entries
  };
}

// ============================================================================
// 2. EXPORT TRAFFIC / CASSETTE -> STANDARD .HAR v1.2
// ============================================================================

function exportToHar(trafficList = [], baseProxyUrl = 'http://localhost:4191') {
  const harEntries = trafficList.map((tx) => {
    const reqHeadersArr = Object.entries(tx.reqHeaders || {}).map(([name, value]) => ({
      name,
      value: String(value)
    }));
    const resHeadersArr = Object.entries(tx.resHeaders || tx.headers || {}).map(([name, value]) => ({
      name,
      value: String(value)
    }));

    const fullUrl = `${baseProxyUrl.replace(/\/+$/, '')}${tx.fullPath || tx.path || '/'}`;
    let queryString = [];
    try {
      const u = new URL(fullUrl);
      queryString = Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
    } catch {}

    const resText = String(tx.resBody || '');
    const reqText = String(tx.reqBody || tx.reqBodySample || '');
    const mimeType =
      (tx.resHeaders && (tx.resHeaders['Content-Type'] || tx.resHeaders['content-type'])) ||
      (tx.headers && tx.headers['content-type']) ||
      'application/json';

    return {
      startedDateTime: tx.timestamp || tx.recordedAt || new Date().toISOString(),
      time: Number(tx.totalMs || tx.originalMs || 25),
      request: {
        method: tx.method || 'GET',
        url: fullUrl,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: reqHeadersArr,
        queryString,
        postData: reqText
          ? {
              mimeType: 'application/json',
              text: reqText
            }
          : undefined,
        headersSize: -1,
        bodySize: Buffer.byteLength(reqText, 'utf8')
      },
      response: {
        status: Number(tx.statusCode) || 200,
        statusText: Number(tx.statusCode) >= 400 ? 'Error' : 'OK',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: resHeadersArr,
        content: {
          size: Buffer.byteLength(resText, 'utf8'),
          mimeType,
          text: resText
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: Buffer.byteLength(resText, 'utf8')
      },
      cache: {},
      timings: {
        blocked: 0,
        dns: -1,
        connect: -1,
        send: 1,
        wait: Number(tx.chaosDelayMs || 0) + Number(tx.upstreamMs || tx.originalMs || 20),
        receive: Number(tx.throttleMs || 1),
        ssl: -1
      }
    };
  });

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'ChaosForge API Chaos & Mock Proxy',
        version: '2.0.0'
      },
      entries: harEntries
    }
  };
}

// ============================================================================
// 3. AUTO-OPENAPI 3.0.3 SCHEMA HARVESTER FROM LIVE TRAFFIC & CASSETTES
// ============================================================================

function normalizeOpenApiPath(pathname) {
  const parts = String(pathname || '/')
    .split('/')
    .filter(Boolean);
  const params = [];

  const normParts = parts.map((seg) => {
    // Match numeric IDs, UUIDs, or prefixed IDs like ord_123, usr_9901, sku_abc
    if (
      /^\d+$/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^(usr|ord|tx|rec|cas|item|prod)_[a-zA-Z0-9_-]+$/i.test(seg)
    ) {
      const paramName = params.length === 0 ? 'id' : `id${params.length + 1}`;
      params.push(paramName);
      return `{${paramName}}`;
    }
    return seg;
  });

  return {
    openApiPath: '/' + normParts.join('/'),
    params
  };
}

function inferSchemaFromValue(val, depth = 0) {
  if (depth > 6) return { type: 'object' };
  if (val === null || val === undefined) {
    return { type: 'string', nullable: true };
  }
  if (Array.isArray(val)) {
    if (val.length === 0) {
      return { type: 'array', items: {} };
    }
    // Merge schema of up to first 3 elements
    let itemSchema = inferSchemaFromValue(val[0], depth + 1);
    for (let i = 1; i < Math.min(val.length, 3); i++) {
      itemSchema = mergeSchemas(itemSchema, inferSchemaFromValue(val[i], depth + 1));
    }
    return { type: 'array', items: itemSchema };
  }
  const t = typeof val;
  if (t === 'boolean') return { type: 'boolean', example: val };
  if (t === 'number') {
    return Number.isInteger(val) ? { type: 'integer', example: val } : { type: 'number', example: val };
  }
  if (t === 'string') {
    const schema = { type: 'string', example: val.slice(0, 80) };
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) schema.format = 'date-time';
    return schema;
  }
  if (t === 'object') {
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(val)) {
      properties[k] = inferSchemaFromValue(v, depth + 1);
      if (v !== null && v !== undefined) required.push(k);
    }
    const out = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  return { type: 'string' };
}

function mergeSchemas(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type !== b.type) {
    return {
      ...a,
      nullable: Boolean(a.nullable || b.nullable)
    };
  }
  if (a.type === 'object' && b.type === 'object') {
    const props = { ...(a.properties || {}) };
    for (const [k, v] of Object.entries(b.properties || {})) {
      props[k] = props[k] ? mergeSchemas(props[k], v) : v;
    }
    const reqSet = new Set((a.required || []).filter((k) => (b.required || []).includes(k)));
    const merged = { type: 'object', properties: props };
    if (reqSet.size > 0) merged.required = Array.from(reqSet);
    if (a.nullable || b.nullable) merged.nullable = true;
    return merged;
  }
  if (a.type === 'array' && b.type === 'array') {
    return {
      type: 'array',
      items: mergeSchemas(a.items, b.items),
      nullable: Boolean(a.nullable || b.nullable)
    };
  }
  const out = { ...a };
  if (a.nullable || b.nullable) out.nullable = true;
  return out;
}

function harvestOpenApiSpec({ trafficLogs = [], cassetteEntries = [], targetUrl = 'http://localhost:4191' }) {
  const paths = {};
  const combined = [
    ...trafficLogs.map((t) => ({
      method: t.method,
      fullPath: t.fullPath || t.path,
      statusCode: t.statusCode,
      reqBody: t.reqBody,
      resBody: t.originalResBody || t.resBody
    })),
    ...cassetteEntries.map((e) => ({
      method: e.method,
      fullPath: e.fullPath || e.path,
      statusCode: e.statusCode,
      reqBody: e.reqBodySample,
      resBody: e.resBody
    }))
  ];

  let analyzedSamples = 0;

  for (const sample of combined) {
    if (!sample.method || !sample.fullPath || !sample.statusCode) continue;
    const methodLower = sample.method.toLowerCase();
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(methodLower)) continue;

    let u;
    try {
      u = new URL(sample.fullPath, 'http://localhost');
    } catch {
      continue;
    }

    const { openApiPath, params } = normalizeOpenApiPath(u.pathname);
    if (!paths[openApiPath]) paths[openApiPath] = {};
    if (!paths[openApiPath][methodLower]) {
      paths[openApiPath][methodLower] = {
        summary: `Auto-harvested ${sample.method} ${openApiPath}`,
        parameters: params.map((p) => ({
          name: p,
          in: 'path',
          required: true,
          schema: { type: 'string' }
        })),
        responses: {}
      };
    }

    const op = paths[openApiPath][methodLower];

    // Query parameters discovery
    for (const [qk] of u.searchParams.entries()) {
      if (!op.parameters.some((p) => p.in === 'query' && p.name === qk)) {
        op.parameters.push({
          name: qk,
          in: 'query',
          required: false,
          schema: { type: 'string' }
        });
      }
    }

    // Request JSON Schema
    if (sample.reqBody && ['post', 'put', 'patch'].includes(methodLower)) {
      try {
        const reqParsed = JSON.parse(sample.reqBody);
        const reqSchema = inferSchemaFromValue(reqParsed);
        const existingReq = op.requestBody?.content?.['application/json']?.schema;
        op.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: existingReq ? mergeSchemas(existingReq, reqSchema) : reqSchema
            }
          }
        };
      } catch {}
    }

    // Response JSON Schema
    const stKey = String(sample.statusCode);
    let resSchema = null;
    if (sample.resBody) {
      try {
        const resParsed = JSON.parse(sample.resBody);
        resSchema = inferSchemaFromValue(resParsed);
        analyzedSamples++;
      } catch {}
    }

    if (!op.responses[stKey]) {
      op.responses[stKey] = {
        description: sample.statusCode >= 400 ? `Observed Error HTTP ${stKey}` : `Observed Success HTTP ${stKey}`
      };
    }

    if (resSchema) {
      const existingRes = op.responses[stKey].content?.['application/json']?.schema;
      op.responses[stKey].content = {
        'application/json': {
          schema: existingRes ? mergeSchemas(existingRes, resSchema) : resSchema
        }
      };
    }
  }

  return {
    analyzedSamples,
    endpointCount: Object.keys(paths).length,
    spec: {
      openapi: '3.0.3',
      info: {
        title: 'ChaosForge Harvested API Specification',
        version: '2.0.0',
        description: `Tự động suy luận từ lưu lượng thực tế qua ChaosForge Proxy (Upstream: ${targetUrl}).`
      },
      servers: [
        { url: 'http://localhost:4191', description: 'ChaosForge Local Proxy Gateway' },
        { url: targetUrl, description: 'Upstream Target Server' }
      ],
      paths
    }
  };
}

module.exports = {
  importHarToCassette,
  exportToHar,
  harvestOpenApiSpec
};
