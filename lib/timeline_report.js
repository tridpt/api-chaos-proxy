/**
 * 🎬 ChaosForge v2.0 — Chaos Timeline Storyboard (GameDay Runner) & Markdown Audit Report Generator
 */

const TIMELINE_TEMPLATES = {
  flash_sale_gameday: {
    id: 'flash_sale_gameday',
    name: '🌩️ Flash-Sale 32s (Êm ➔ Nghẽn Mạng ➔ Bão 429 ➔ Hồi Phục)',
    description: 'Mô phỏng lưu lượng tăng đột biến lúc 0h00: từ 0ms vọt lên 1.5s trễ, kế tiếp 50% lỗi 429/503 rồi tự hồi phục.',
    stages: [
      {
        name: 'Pha 1: Baseline Ổn định (0ms)',
        durationSec: 6,
        patch: {
          mode: 'PASSTHROUGH',
          chaos: { latencyMs: 0, jitterMs: 0, spikeRate: 0, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      },
      {
        name: 'Pha 2: Nghẽn băng thông (Lag 1.4s + Jitter)',
        durationSec: 10,
        patch: {
          mode: 'CHAOS',
          chaos: { latencyMs: 1400, jitterMs: 600, spikeRate: 25, spikeMs: 3200, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      },
      {
        name: 'Pha 3: Đỉnh bão Quá tải (50% HTTP 429/503)',
        durationSec: 10,
        patch: {
          mode: 'CHAOS',
          chaos: { latencyMs: 350, jitterMs: 250, spikeRate: 0, errorRate: 50, errorCodes: [429, 503], dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      },
      {
        name: 'Pha 4: Hạ nhiệt & Phục hồi hoàn toàn',
        durationSec: 6,
        patch: {
          mode: 'PASSTHROUGH',
          chaos: { latencyMs: 0, jitterMs: 0, spikeRate: 0, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      }
    ]
  },

  outage_and_corruption: {
    id: 'outage_and_corruption',
    name: '🔌 Sập Cụm Máy Chủ & Hậu Chấn JSON 28s (Kèm Cắt WebSocket)',
    description: 'Đánh sập kết nối 502 + TCP Reset + Cắt toàn bộ WebSocket đang mở, tiếp nối bằng dữ liệu JSON khuyết null trước khi hồi phục.',
    stages: [
      {
        name: 'Pha 1: Hệ thống Bình thường',
        durationSec: 5,
        patch: {
          mode: 'PASSTHROUGH',
          chaos: { latencyMs: 0, jitterMs: 0, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      },
      {
        name: 'Pha 2: Đứt cáp & Cắt WebSocket (70% 502 + 20% TCP Drop)',
        durationSec: 9,
        killWs: true,
        patch: {
          mode: 'CHAOS',
          chaos: { latencyMs: 250, jitterMs: 200, errorRate: 70, errorCodes: [502, 503], dropRate: 20, hangRate: 0 },
          mutator: { enabled: false }
        }
      },
      {
        name: 'Pha 3: Hậu chấn Cache Bẩn (200 OK nhưng Nullify JSON)',
        durationSec: 8,
        patch: {
          mode: 'CHAOS',
          chaos: { latencyMs: 120, jitterMs: 100, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: true, nullifyFields: true, overflowStrings: true, truncateJson: false }
        }
      },
      {
        name: 'Pha 4: Khôi phục Xanh (Clean 0ms)',
        durationSec: 6,
        patch: {
          mode: 'PASSTHROUGH',
          chaos: { latencyMs: 0, jitterMs: 0, errorRate: 0, dropRate: 0, hangRate: 0 },
          mutator: { enabled: false }
        }
      }
    ]
  },

  ai_auth_storm: {
    id: 'ai_auth_storm',
    name: '🤖 Bão AI Stream & Hết Hạn Token Đồng Loạt 26s',
    description: 'Khựng luồng SSE AI giữa câu 2.5s + Đứt stream 40%, tiếp theo kích hoạt bão hết hạn JWT 401 kiểm tra Refresh Mutex.',
    stages: [
      {
        name: 'Pha 1: AI Stream & Auth Mượt',
        durationSec: 5,
        patch: {
          mode: 'CHAOS',
          chaos: { latencyMs: 0, errorRate: 0, dropRate: 0, hangRate: 0 },
          streamChaos: { enabled: false, tokenDelayMs: 0, stallMidStreamMs: 0, dropMidStreamRate: 0 }
        }
      },
      {
        name: 'Pha 2: Nghẽn GPU Stream (Khựng 2.2s giữa câu + 40% Đứt SSE)',
        durationSec: 9,
        patch: {
          mode: 'CHAOS',
          streamChaos: { enabled: true, tokenDelayMs: 90, stallMidStreamMs: 2200, dropMidStreamRate: 40, corruptEventRate: 30 }
        }
      },
      {
        name: 'Pha 3: Bão 401 Token Expired (Kiểm tra Refresh Race)',
        durationSec: 7,
        expireAuthNow: true,
        patch: {
          mode: 'CHAOS',
          streamChaos: { enabled: false },
          authChaos: { enabled: true }
        }
      },
      {
        name: 'Pha 4: Ổn định hoàn toàn',
        durationSec: 5,
        patch: {
          mode: 'PASSTHROUGH',
          streamChaos: { enabled: false }
        }
      }
    ]
  }
};

class TimelineRunner {
  constructor({ applyPatchFn, restoreConfigFn, getSnapshotFn, killWsFn, expireAuthFn, broadcastFn }) {
    this.applyPatchFn = applyPatchFn;
    this.restoreConfigFn = restoreConfigFn;
    this.getSnapshotFn = getSnapshotFn;
    this.killWsFn = killWsFn;
    this.expireAuthFn = expireAuthFn;
    this.broadcastFn = broadcastFn;

    this.running = false;
    this.timer = null;
    this.savedConfig = null;
    this.activeRun = null;
    this.lastCompletedRun = null;
  }

  getStatus() {
    return {
      running: this.running,
      activeRun: this.activeRun,
      lastCompletedRun: this.lastCompletedRun,
      templates: TIMELINE_TEMPLATES
    };
  }

  start(templateIdOrCustom) {
    if (this.running) {
      this.stop('restarted');
    }

    const tpl =
      typeof templateIdOrCustom === 'string'
        ? TIMELINE_TEMPLATES[templateIdOrCustom]
        : templateIdOrCustom;

    if (!tpl || !Array.isArray(tpl.stages) || tpl.stages.length === 0) {
      throw new Error('Kịch bản Timeline không hợp lệ');
    }

    this.savedConfig = JSON.parse(JSON.stringify(this.getSnapshotFn()));
    const totalSec = tpl.stages.reduce((s, st) => s + Math.max(1, Number(st.durationSec) || 5), 0);

    // Compute cumulative boundaries
    let acc = 0;
    const stagesWithBounds = tpl.stages.map((st, idx) => {
      const dur = Math.max(1, Number(st.durationSec) || 5);
      const item = {
        index: idx,
        name: st.name || `Pha ${idx + 1}`,
        durationSec: dur,
        startSec: acc,
        endSec: acc + dur,
        patch: st.patch || {},
        killWs: Boolean(st.killWs),
        expireAuthNow: Boolean(st.expireAuthNow)
      };
      acc += dur;
      return item;
    });

    this.running = true;
    this.activeRun = {
      id: 'tl-' + Date.now().toString(36),
      templateId: tpl.id || 'custom',
      name: tpl.name || 'Custom Chaos Timeline',
      startedAtMs: Date.now(),
      startedAtIso: new Date().toISOString(),
      totalSec,
      elapsedSec: 0,
      currentStageIndex: -1,
      currentStageName: '',
      stages: stagesWithBounds
    };

    this._enterStage(0);

    this.timer = setInterval(() => {
      if (!this.running || !this.activeRun) return;
      const elapsedSec = Math.min(
        this.activeRun.totalSec,
        Math.round(((Date.now() - this.activeRun.startedAtMs) / 1000) * 10) / 10
      );
      this.activeRun.elapsedSec = elapsedSec;

      if (elapsedSec >= this.activeRun.totalSec) {
        this.stop('completed');
        return;
      }

      const nextStageIdx = this.activeRun.stages.findIndex(
        (st) => elapsedSec >= st.startSec && elapsedSec < st.endSec
      );
      if (nextStageIdx !== -1 && nextStageIdx !== this.activeRun.currentStageIndex) {
        this._enterStage(nextStageIdx);
      }

      this.broadcastFn('timeline:tick', {
        id: this.activeRun.id,
        name: this.activeRun.name,
        elapsedSec,
        totalSec: this.activeRun.totalSec,
        currentStageIndex: this.activeRun.currentStageIndex,
        currentStageName: this.activeRun.currentStageName
      });
    }, 500);

    return this.activeRun;
  }

  _enterStage(idx) {
    const st = this.activeRun.stages[idx];
    if (!st) return;
    this.activeRun.currentStageIndex = idx;
    this.activeRun.currentStageName = st.name;

    this.applyPatchFn(st.patch);
    if (st.killWs && typeof this.killWsFn === 'function') {
      this.killWsFn();
    }
    if (st.expireAuthNow && typeof this.expireAuthFn === 'function') {
      this.expireAuthFn();
    }

    this.broadcastFn('timeline:stage', {
      id: this.activeRun.id,
      stageIndex: idx,
      stageName: st.name,
      totalStages: this.activeRun.stages.length
    });
  }

  stop(reason = 'stopped') {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeRun) {
      this.lastCompletedRun = {
        ...this.activeRun,
        endedAtIso: new Date().toISOString(),
        reason
      };
    }
    this.running = false;
    this.activeRun = null;

    if (this.savedConfig) {
      this.restoreConfigFn(this.savedConfig);
      this.savedConfig = null;
    }

    this.broadcastFn('timeline:done', {
      reason,
      lastCompletedRun: this.lastCompletedRun
    });
    return this.lastCompletedRun;
  }
}

// ============================================================================
// MARKDOWN AUDIT REPORT GENERATOR
// ============================================================================

function generateMarkdownAuditReport({ trafficLogs = [], telemetry = {}, authStats = {}, timelineRun = null, targetUrl = '' }) {
  const nowIso = new Date().toISOString();
  const windowLogs = timelineRun
    ? trafficLogs.filter((t) => t.timestamp >= timelineRun.startedAtIso)
    : trafficLogs;

  const sampleList = windowLogs.length > 0 ? windowLogs : trafficLogs;
  const total = sampleList.length;

  let status2xx = 0;
  let status4xx = 0;
  let status5xx = 0;
  let dropped = 0;
  let mutated = 0;
  let sseStreams = 0;
  let gqlCalls = 0;
  let clientTimeouts = 0;
  const latencies = [];

  for (const t of sampleList) {
    if (t.statusCode === 0) dropped++;
    else if (t.statusCode >= 500) status5xx++;
    else if (t.statusCode >= 400) status4xx++;
    else status2xx++;

    if (t.mutationsApplied && t.mutationsApplied.length > 0) mutated++;
    if ((t.chaosBadges || []).some((b) => b.includes('SSE'))) sseStreams++;
    if (t.graphqlOperation) gqlCalls++;
    if (t.clientAborted) clientTimeouts++;
    latencies.push(t.totalMs || 0);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const maxLat = latencies[latencies.length - 1] || 0;

  const risks = [];
  if ((telemetry.doubleSubmitIncidents || 0) > 0) {
    risks.push(`- ❌ **Phát hiện ${telemetry.doubleSubmitIncidents} lần lỗi Double-Submit (Trừ tiền/Gửi đơn lặp):** Frontend chưa khóa nút in-flight hoặc thiếu \`X-Idempotency-Key\` khi mạng lag.`);
  } else {
    risks.push(`- ✅ **Chống Double-Submit:** Không ghi nhận giao dịch bị gửi lặp khi độ trễ tăng cao.`);
  }

  if ((authStats.raceIncidents || 0) > 0) {
    risks.push(`- ❌ **Phát hiện ${authStats.raceIncidents} lần Bão Refresh Token Song Song (401 Race Condition):** Nhiều API dính 401 cùng lúc đã gọi \`/auth/refresh\` chồng chéo thay vì dùng hàng đợi Mutex.`);
  } else {
    risks.push(`- ✅ **Quản lý 401 Token Refresh:** Không phát hiện xung đột gọi lặp Refresh Token.`);
  }

  if (maxLat > 4000 && clientTimeouts === 0) {
    risks.push(`- ⚠️ **Cảnh báo thiếu Timeout:** Có gói tin trễ tới **${maxLat}ms** nhưng chưa thấy Frontend chủ động cắt bằng \`AbortController\`.`);
  } else if (clientTimeouts > 0) {
    risks.push(`- ✅ **Kiểm soát Timeout chủ động:** Frontend đã chủ động ngắt **${clientTimeouts}** kết nối quá hạn bằng \`AbortController\`.`);
  }

  const lines = [
    `# ⚡ Báo Cáo Kiểm Định Độ Bền Frontend — ChaosForge v2.0`,
    ``,
    `- **Thời điểm xuất báo cáo:** \`${nowIso}\``,
    `- **Upstream Backend đích:** \`${targetUrl}\``,
    timelineRun
      ? `- **Kịch bản GameDay đã chạy:** **${timelineRun.name}** (\`${timelineRun.totalSec}s\` — Kết thúc: \`${timelineRun.reason}\`)`
      : `- **Phạm vi dữ liệu:** Toàn bộ phiên giám sát hiện tại (${total} gói tin)`,
    ``,
    `## 1. Thống Kê Lưu Lượng & Độ Trễ`,
    ``,
    `| Chỉ số | Giá trị |`,
    `| :--- | :---: |`,
    `| Tổng số Request qua Proxy | **${total}** |`,
    `| Thành công (\`2xx\`) | **${status2xx}** |`,
    `| Lỗi phía Client / Rate-Limit (\`4xx / 429\`) | **${status4xx}** |`,
    `| Lỗi phía Máy chủ (\`5xx\`) | **${status5xx}** |`,
    `| Đứt kết nối TCP / Frontend Timeout | **${dropped}** (Timeout chủ động: **${clientTimeouts}**) |`,
    `| Gói tin Đột biến JSON trên đường truyền | **${mutated}** |`,
    `| Luồng AI SSE Stream / GraphQL Operations | **${sseStreams}** SSE · **${gqlCalls}** GraphQL |`,
    `| Độ trễ P50 / P95 / Đỉnh (Max) | **${p50} ms** / **${p95} ms** / **${maxLat} ms** |`,
    ``,
    `## 2. Chẩn Đoán Rủi Ro Kiến Trúc Frontend`,
    ``,
    ...risks,
    ``,
    `## 3. Nhật Ký 15 Gói Tin Đáng Chú Ý Gần Nhất`,
    ``,
    `| Thời gian | Method & Path | Status | Độ trễ | Nhãn Chaos / Đột biến |`,
    `| :--- | :--- | :---: | :---: | :--- |`,
    ...sampleList.slice(0, 15).map((t) => {
      const tags = [...(t.chaosBadges || []), ...(t.mutationsApplied || [])].join(', ') || 'Clean';
      return `| \`${(t.timestamp || '').slice(11, 19)}\` | \`${t.method} ${t.fullPath}\` | **${t.statusCode || 'DROP'}** | ${t.totalMs}ms | ${tags} |`;
    }),
    ``
  ];

  return lines.join('\n');
}

module.exports = {
  TIMELINE_TEMPLATES,
  TimelineRunner,
  generateMarkdownAuditReport
};
