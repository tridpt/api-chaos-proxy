/**
 * 🤖 ChaosForge v2.0 — SSE / AI Token Stream Chaos & WebSocket Tunnel Engine
 * Pure Node.js standard library (http, https, net, tls, crypto)
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { performance } = require('node:perf_hooks');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const activeWsSockets = new Map(); // id -> { id, path, connectedAt, frames, closeFn }

function getActiveWsList() {
  return Array.from(activeWsSockets.values()).map(({ id, path, connectedAt, frames }) => ({
    id,
    path,
    connectedAt,
    frames
  }));
}

function killAllWebSockets() {
  let count = 0;
  for (const item of activeWsSockets.values()) {
    try {
      item.closeFn();
      count++;
    } catch {}
  }
  activeWsSockets.clear();
  return count;
}

// ============================================================================
// 1. BUILT-IN DEMO AI TOKEN STREAM (/demo-api/ai/stream)
// ============================================================================

async function handleDemoAiStream(req, res, promptText = '') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const tokens = [
    'Phân ',
    'tích ',
    'độ bền ',
    'giao diện: ',
    'Luồng ',
    'SSE ',
    'hoạt động ',
    'ổn định ',
    '100% ',
    'qua ChaosForge! ⚡'
  ];

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  for (let i = 0; i < tokens.length; i++) {
    if (closed || res.writableEnded) return;
    const frame = JSON.stringify({
      id: `tok_${i}`,
      index: i,
      delta: tokens[i],
      promptEcho: i === 0 ? promptText.slice(0, 60) : undefined
    });
    res.write(`id: ${i}\nevent: message\ndata: ${frame}\n\n`);
    await new Promise((r) => setTimeout(r, 55));
  }

  if (!closed && !res.writableEnded) {
    res.write(`event: done\ndata: [DONE]\n\n`);
    res.end();
  }
}

// ============================================================================
// 2. SSE / NDJSON UPSTREAM STREAMING PROXY WITH MID-STREAM CHAOS
// ============================================================================

function isStreamRequestOrHeader(reqHeaders, contentType = '') {
  const accept = String(reqHeaders['accept'] || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  return (
    accept.includes('text/event-stream') ||
    ct.includes('text/event-stream') ||
    ct.includes('application/x-ndjson')
  );
}

function proxySseUpstream({
  method,
  upstreamUrlStr,
  reqHeaders,
  reqBodyBuf,
  hopCount,
  res,
  streamChaosCfg,
  applyCorsHeaders,
  txId,
  abortState
}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(upstreamUrlStr);
    } catch (err) {
      return reject(err);
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const outHeaders = {};
    for (const [k, v] of Object.entries(reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lk)) continue;
      outHeaders[k] = v;
    }
    outHeaders['host'] = parsedUrl.host;
    outHeaders['accept-encoding'] = 'identity';
    outHeaders['x-chaosforge-hop'] = String(hopCount + 1);
    if (reqBodyBuf && reqBodyBuf.length > 0) {
      outHeaders['content-length'] = Buffer.byteLength(reqBodyBuf);
    }

    const t0 = performance.now();
    const badges = ['SSE_STREAM'];
    let capturedPreview = '';
    let chunkIndex = 0;
    let stalledAlready = false;
    let corruptInjected = false;

    const shouldDropMidStream =
      streamChaosCfg.enabled &&
      Number(streamChaosCfg.dropMidStreamRate) > 0 &&
      Math.random() * 100 < Number(streamChaosCfg.dropMidStreamRate);
    const dropAtChunk = 3 + Math.floor(Math.random() * 3); // Cut after 3..5 chunks

    const upstreamReq = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: outHeaders,
        rejectUnauthorized: false
      },
      (upstreamRes) => {
        const resHeaders = {
          'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-ChaosForge-Id': txId,
          'X-ChaosForge-Source': 'SSE_UPSTREAM'
        };
        applyCorsHeaders(resHeaders, reqHeaders, false);
        res.writeHead(upstreamRes.statusCode || 200, resHeaders);

        // Sequential async queue so delays/stalls preserve exact token order
        let chain = Promise.resolve();

        upstreamRes.on('data', (chunk) => {
          const textChunk = chunk.toString('utf8');
          chain = chain.then(async () => {
            if (abortState.aborted || res.destroyed || res.writableEnded) return;
            chunkIndex++;

            // 1. Mid-stream Stall (e.g. 3000ms freeze mid-sentence)
            if (
              streamChaosCfg.enabled &&
              !stalledAlready &&
              chunkIndex === 3 &&
              Number(streamChaosCfg.stallMidStreamMs) > 0
            ) {
              stalledAlready = true;
              const stallMs = Number(streamChaosCfg.stallMidStreamMs);
              badges.push(`STREAM_STALL_${stallMs}ms`);
              await new Promise((r) => setTimeout(r, stallMs));
            }

            // 2. Per-token jitter/delay
            if (streamChaosCfg.enabled && Number(streamChaosCfg.tokenDelayMs) > 0) {
              await new Promise((r) => setTimeout(r, Number(streamChaosCfg.tokenDelayMs)));
            }

            if (abortState.aborted || res.destroyed || res.writableEnded) return;

            // 3. Violent Mid-stream Drop
            if (shouldDropMidStream && chunkIndex >= dropAtChunk) {
              if (!badges.includes('MID_STREAM_DROP')) badges.push('MID_STREAM_DROP');
              upstreamReq.destroy();
              res.destroy();
              return;
            }

            // 4. Corrupt SSE Frame Injection
            if (
              streamChaosCfg.enabled &&
              !corruptInjected &&
              chunkIndex === 2 &&
              Number(streamChaosCfg.corruptEventRate) > 0 &&
              Math.random() * 100 < Number(streamChaosCfg.corruptEventRate)
            ) {
              corruptInjected = true;
              badges.push('SSE_CORRUPT_FRAME');
              const badFrame = `event: message\ndata: {"delta": "⚡BROKEN_JSON", MALFORMED_TOKEN\n\n`;
              res.write(badFrame);
              capturedPreview += badFrame;
            }

            // Write actual chunk
            res.write(chunk);
            if (capturedPreview.length < 16384) capturedPreview += textChunk;

            // 5. Duplicate Chunk Chaos (tests client deduplication by id)
            if (
              streamChaosCfg.enabled &&
              Number(streamChaosCfg.duplicateChunkRate) > 0 &&
              Math.random() * 100 < Number(streamChaosCfg.duplicateChunkRate)
            ) {
              if (!badges.includes('SSE_DUP_CHUNK')) badges.push('SSE_DUP_CHUNK');
              res.write(chunk);
              if (capturedPreview.length < 16384) capturedPreview += textChunk;
            }
          });
        });

        upstreamRes.on('end', () => {
          chain.then(() => {
            if (!res.writableEnded && !res.destroyed) {
              res.end();
            }
            resolve({
              statusCode: upstreamRes.statusCode || 200,
              headers: resHeaders,
              capturedBody: capturedPreview,
              badges,
              upstreamMs: Math.round(performance.now() - t0)
            });
          });
        });

        upstreamRes.on('error', () => {
          chain.then(() => {
            if (!res.writableEnded && !res.destroyed) res.end();
            resolve({
              statusCode: upstreamRes.statusCode || 200,
              headers: resHeaders,
              capturedBody: capturedPreview,
              badges,
              upstreamMs: Math.round(performance.now() - t0)
            });
          });
        });
      }
    );

    upstreamReq.on('error', reject);
    if (reqBodyBuf && reqBodyBuf.length > 0) upstreamReq.write(reqBodyBuf);
    upstreamReq.end();
  });
}

// ============================================================================
// 3. NATIVE RFC 6455 DEMO WEBSOCKET SERVER (/demo-api/ws)
// ============================================================================

function encodeWsTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsClientFrame(buf) {
  if (!buf || buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x08) return { type: 'close' };
  if (opcode === 0x09) return { type: 'ping' };

  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  const data = Buffer.from(buf.subarray(offset, offset + len));
  if (masked && maskKey) {
    for (let i = 0; i < data.length; i++) {
      data[i] ^= maskKey[i % 4];
    }
  }
  return { type: 'text', text: data.toString('utf8') };
}

function handleDemoWsUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  );

  let tickSeq = 1;
  const sendJsonFrame = (obj) => {
    if (!socket.destroyed && socket.writable) {
      socket.write(encodeWsTextFrame(JSON.stringify(obj)));
    }
  };

  sendJsonFrame({
    type: 'welcome',
    message: 'Đã kết nối WebSocket PayFlow Realtime Ticker!',
    ts: new Date().toISOString()
  });

  const ticker = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(ticker);
      return;
    }
    sendJsonFrame({
      type: 'ticker',
      seq: tickSeq++,
      vn30: +(1280 + Math.random() * 15).toFixed(2),
      activeUsers: 140 + Math.floor(Math.random() * 40),
      ts: new Date().toISOString()
    });
  }, 2200);

  socket.on('data', (buf) => {
    const parsed = decodeWsClientFrame(buf);
    if (!parsed) return;
    if (parsed.type === 'close') {
      clearInterval(ticker);
      socket.end();
      return;
    }
    if (parsed.type === 'text') {
      sendJsonFrame({
        type: 'echo',
        received: parsed.text,
        serverTs: new Date().toISOString()
      });
    }
  });

  socket.on('close', () => clearInterval(ticker));
  socket.on('error', () => clearInterval(ticker));
}

// ============================================================================
// 4. TRANSPARENT WEBSOCKET PROXY TUNNEL WITH CHAOS (PORT 4191)
// ============================================================================

function handleProxyWsUpgrade(req, clientSocket, head, getConfigFn, onEventFn) {
  const cfg = getConfigFn();
  const wsChaos = cfg.wsChaos || {};
  const reqUrl = req.url || '/';

  // 1. Handshake Reject Chaos (503 Service Unavailable on WS connect)
  if (
    cfg.mode === 'CHAOS' &&
    wsChaos.enabled &&
    Number(wsChaos.rejectHandshakeRate) > 0 &&
    Math.random() * 100 < Number(wsChaos.rejectHandshakeRate)
  ) {
    clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nWS Handshake Rejected by ChaosForge\r\n');
    clientSocket.destroy();
    onEventFn('ws:rejected', { path: reqUrl });
    return;
  }

  let targetBase;
  try {
    targetBase = new URL(cfg.targetUrl);
  } catch {
    clientSocket.destroy();
    return;
  }

  const isSecure = targetBase.protocol === 'https:' || targetBase.protocol === 'wss:';
  const port = Number(targetBase.port) || (isSecure ? 443 : 80);
  const basePath = targetBase.pathname.replace(/\/+$/, '');
  const fullTargetPath = basePath + (reqUrl.startsWith('/') ? reqUrl : '/' + reqUrl);

  const wsId = 'ws-' + crypto.randomBytes(3).toString('hex');
  const wsRecord = {
    id: wsId,
    path: reqUrl,
    target: `${targetBase.host}${fullTargetPath}`,
    connectedAt: new Date().toISOString(),
    frames: 0,
    closeFn: () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    }
  };

  const upstreamSocket = isSecure
    ? tls.connect({ host: targetBase.hostname, port, servername: targetBase.hostname, rejectUnauthorized: false })
    : net.connect({ host: targetBase.hostname, port });

  let autoDropTimer = null;

  upstreamSocket.on('connect', () => {
    // Reconstruct HTTP Upgrade request to upstream
    const headerLines = [`GET ${fullTargetPath} HTTP/1.1`, `Host: ${targetBase.host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      headerLines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    headerLines.push('\r\n');
    upstreamSocket.write(headerLines.join('\r\n'));
    if (head && head.length > 0) upstreamSocket.write(head);

    activeWsSockets.set(wsId, wsRecord);
    onEventFn('ws:open', { id: wsId, path: reqUrl, activeCount: activeWsSockets.size });

    // Optional Auto-Drop timer to test client WebSocket Auto-Reconnect!
    if (cfg.mode === 'CHAOS' && wsChaos.enabled && Number(wsChaos.autoDropAfterSec) > 0) {
      autoDropTimer = setTimeout(() => {
        onEventFn('ws:dropped', { id: wsId, path: reqUrl, reason: 'AUTO_DROP_TIMER' });
        wsRecord.closeFn();
      }, Number(wsChaos.autoDropAfterSec) * 1000);
    }
  });

  const forwardChunk = (chunk, destSocket) => {
    wsRecord.frames++;
    const delay =
      getConfigFn().mode === 'CHAOS' && getConfigFn().wsChaos?.enabled
        ? Number(getConfigFn().wsChaos.frameDelayMs) || 0
        : 0;
    if (delay > 0) {
      setTimeout(() => {
        if (!destSocket.destroyed && destSocket.writable) destSocket.write(chunk);
      }, delay);
    } else if (!destSocket.destroyed && destSocket.writable) {
      destSocket.write(chunk);
    }
  };

  upstreamSocket.on('data', (chunk) => forwardChunk(chunk, clientSocket));
  clientSocket.on('data', (chunk) => forwardChunk(chunk, upstreamSocket));

  const cleanup = () => {
    if (autoDropTimer) clearTimeout(autoDropTimer);
    if (activeWsSockets.has(wsId)) {
      activeWsSockets.delete(wsId);
      onEventFn('ws:close', { id: wsId, path: reqUrl, activeCount: activeWsSockets.size });
    }
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  upstreamSocket.on('close', cleanup);
  upstreamSocket.on('error', cleanup);
  clientSocket.on('close', cleanup);
  clientSocket.on('error', cleanup);
}

module.exports = {
  getActiveWsList,
  killAllWebSockets,
  handleDemoAiStream,
  isStreamRequestOrHeader,
  proxySseUpstream,
  handleDemoWsUpgrade,
  handleProxyWsUpgrade
};
