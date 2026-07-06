import { useEffect, useRef, useState } from 'react';
import type { MetricSnapshot } from '../types/api';

interface DiagnosisPanelProps {
  snapshots: MetricSnapshot[];
  submissionId: string | null;
}

type Severity = 'critical' | 'warning' | 'ok';

interface DiagnosisCard {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

// interface WindowDetail {
//   windowNum: number;
//   timestamp: string;
//   tps: number;
//   p99LatencyMs: number;
//   errorPct: number;
//   successCount: number;
//   timeoutCount: number;
//   correctnessPct: number;
// }

// function snapshotToWindow(num: number, snap: MetricSnapshot): WindowDetail {
//   const total = snap.successCount + snap.failureCount + snap.timeoutCount;
//   const errPct = total > 0 ? ((snap.failureCount + snap.timeoutCount) / total) * 100 : 0;
//   return {
//     windowNum: num,
//     timestamp: new Date(snap.windowEnd).toLocaleTimeString('en-US', {
//       hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
//     }),
//     tps: snap.tps,
//     p99LatencyMs: snap.p99LatencyMs,
//     errorPct: errPct,
//     successCount: snap.successCount,
//     timeoutCount: snap.timeoutCount,
//     correctnessPct: norm(snap.correctnessScore),
//   };
// }

interface WindowDetail {
  windowNum: number;
  timestamp: string;
  tps: number;
  p99LatencyMs: number;
  errorPct: number;
  successCount: number;
  timeoutCount: number;
  correctnessPct: number;
}

function snapshotToWindow(num: number, snap: MetricSnapshot): WindowDetail {
  const total = snap.successCount + snap.failureCount + snap.timeoutCount;
  const errPct = total > 0 ? ((snap.failureCount + snap.timeoutCount) / total) * 100 : 0;
  return {
    windowNum: num,
    timestamp: new Date(snap.windowEnd).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
    tps: snap.tps,
    p99LatencyMs: snap.p99LatencyMs,
    errorPct: errPct,
    successCount: snap.successCount,
    timeoutCount: snap.timeoutCount,
    correctnessPct: norm(snap.correctnessScore),
  };
}

// ── Analysis helpers ──────────────────────────────────────────────────────────

function errRate(s: MetricSnapshot): number {
  const total = s.successCount + s.failureCount + s.timeoutCount;
  return total > 0 ? (s.failureCount + s.timeoutCount) / total : 0;
}

function norm(v: number): number {
  return v <= 1.0 ? v * 100 : v;
}

// ── Rule Engine ───────────────────────────────────────────────────────────────

function diagnose(snapshots: MetricSnapshot[]): DiagnosisCard[] {
  const cards: DiagnosisCard[] = [];
  if (snapshots.length < 3) return cards;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  let maxP99 = 0, sumP99 = 0, sumErr = 0, sumCorr = 0;
  snapshots.forEach(s => {
    maxP99 = Math.max(maxP99, s.p99LatencyMs);
    sumP99 += s.p99LatencyMs;
    sumErr += errRate(s);
    sumCorr += norm(s.correctnessScore);
  });

  const avgP99 = sumP99 / snapshots.length;
  const overallErrPct = (sumErr / snapshots.length) * 100;
  const avgCorr = sumCorr / snapshots.length;
  const startErr = errRate(first);
  const endErr = errRate(last);
  const tpsStart = first.tps;
  const tpsEnd = last.tps;
  const tpsDrop = tpsStart > 0 ? (tpsStart - tpsEnd) / tpsStart : 0;
  const totalTimeouts = snapshots.reduce((a, s) => a + s.timeoutCount, 0);
  const totalFailed = snapshots.reduce((a, s) => a + s.failureCount, 0);

  // RULE 1: Cascading failure
  if (endErr > startErr + 0.1 && endErr > 0.05 && last.tps < first.tps) {
    cards.push({
      id: 'cascading-failure', severity: 'critical',
      title: 'Cascading Failure',
      detail: `Error rate ${(startErr*100).toFixed(1)}% → ${(endErr*100).toFixed(1)}% as TPS collapsed. Queue backlog overwhelmed workers.`,
    });
  }

  // RULE 2: Latency spikes
  if (maxP99 > avgP99 * 3 && maxP99 > 500) {
    cards.push({
      id: 'latency-spike', severity: maxP99 > 1500 ? 'critical' : 'warning',
      title: 'Tail Latency Spikes',
      detail: `P99 hit ${maxP99.toFixed(0)}ms vs avg ${avgP99.toFixed(0)}ms — likely GC pause or hot-path lock contention.`,
    });
  }

  // RULE 3: Timeouts
  if (totalTimeouts > 500) {
    cards.push({
      id: 'frequent-timeouts', severity: 'critical',
      title: 'High Timeout Volume',
      detail: `${totalTimeouts.toLocaleString()} requests hit gateway timeout. Matching engine too slow for incoming TPS.`,
    });
  }

  // RULE 4: Fast but wrong (race condition)
  if (avgP99 < 50 && avgCorr < 90) {
    cards.push({
      id: 'race-condition', severity: avgCorr < 50 ? 'critical' : 'warning',
      title: 'Fast but Incorrect',
      detail: `Latency OK (${avgP99.toFixed(0)}ms) but correctness ${avgCorr.toFixed(1)}% — unprotected concurrent order book writes.`,
    });
  }

  // RULE 5: Rejection flood
  if (totalFailed > totalTimeouts * 5 && totalFailed > 100) {
    cards.push({
      id: 'high-rejection', severity: 'warning',
      title: 'High Rejection Rate',
      detail: `${totalFailed.toLocaleString()} explicit 5xx/4xx rejections. Check for unhandled panics or invalid payload crashes.`,
    });
  }

  // RULE 6: Cold start penalty
  if (first.p50LatencyMs > last.p50LatencyMs * 2 && first.p50LatencyMs > 200) {
    cards.push({
      id: 'cold-start', severity: 'warning',
      title: 'Cold Start Penalty',
      detail: `Initial P50 ${first.p50LatencyMs.toFixed(0)}ms settled to ${last.p50LatencyMs.toFixed(0)}ms — JIT warmup or lazy init hurting score.`,
    });
  }

  // RULE 7: Throughput collapse
  if (tpsDrop > 0.35 && tpsStart > 10) {
    cards.push({
      id: 'tps-collapse', severity: tpsDrop > 0.6 ? 'critical' : 'warning',
      title: 'Throughput Collapse',
      detail: `TPS ${tpsStart.toFixed(0)} → ${tpsEnd.toFixed(0)} (${(tpsDrop*100).toFixed(0)}% drop) — memory leak, goroutine leak, or unbounded order book.`,
    });
  }

  // HEALTHY
  if (cards.length === 0) {
    cards.push({
      id: 'ok', severity: 'ok',
      title: 'No Issues Detected',
      detail: `Error ${overallErrPct.toFixed(2)}%  ·  P99 avg ${avgP99.toFixed(0)}ms  ·  Correctness ${avgCorr.toFixed(1)}%`,
    });
  }

  return cards;
}

// ── Severity badge ────────────────────────────────────────────────────────────

function SeverityChip({ s }: { s: Severity }) {
  const color = s === 'critical' ? 'var(--red)' : s === 'warning' ? 'var(--amber)' : 'var(--green)';
  const label = s === 'critical' ? 'CRIT' : s === 'warning' ? 'WARN' : 'OK';
  return <span className="diag-chip" style={{ background: color }}>{label}</span>;
}

// ── Main component ────────────────────────────────────────────────────────────

interface CachedDiagnosis {
  id: string;
  timestamp: string;
  snapshotCount: number;
  cards: DiagnosisCard[];
  windows: WindowDetail[];
}

function rcaStorageKey(submissionId: string): string {
  return `bench_rca_${submissionId}`;
}

function loadCachedDiagnosis(submissionId: string): CachedDiagnosis | null {
  try {
    const stored = localStorage.getItem(rcaStorageKey(submissionId));
    if (!stored) return null;
    const parsed: CachedDiagnosis = JSON.parse(stored);
    return { ...parsed, windows: parsed.windows ?? [] };
  } catch {
    return null;
  }
}

export function DiagnosisPanel({ snapshots, submissionId }: DiagnosisPanelProps) {
  const [diagnosis, setDiagnosis] = useState<CachedDiagnosis | null>(null);
  const lastCountRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);

  // Load only the current submission's RCA data; discard any previous run.
  useEffect(() => {
    if (!submissionId) {
      activeIdRef.current = null;
      lastCountRef.current = 0;
      setDiagnosis(null);
      return;
    }

    if (activeIdRef.current !== submissionId) {
      activeIdRef.current = submissionId;
      lastCountRef.current = 0;
      setDiagnosis(loadCachedDiagnosis(submissionId));
    }
  }, [submissionId]);

  useEffect(() => {
    if (!submissionId || snapshots.length === 0) return;

    const windows = snapshots.map((s, i) => snapshotToWindow(i + 1, s));
    const countChanged = snapshots.length !== lastCountRef.current;
    const newCards = snapshots.length >= 3 ? diagnose(snapshots) : [];

    if (!countChanged && windows.length === 0) return;
    lastCountRef.current = snapshots.length;

    setDiagnosis(prev => {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

      if (prev && prev.id === submissionId) {
        const existingIds = new Set(prev.cards.map(c => c.id));
        const merged = [
          ...prev.cards,
          ...newCards.filter(c => !existingIds.has(c.id)),
        ];
        const hasIssues = merged.some(c => c.severity !== 'ok');
        const final = hasIssues ? merged.filter(c => c.id !== 'ok') : merged;
        const updated: CachedDiagnosis = {
          ...prev,
          snapshotCount: snapshots.length,
          cards: final,
          windows,
          timestamp: ts,
        };
        localStorage.setItem(rcaStorageKey(submissionId), JSON.stringify(updated));
        return updated;
      }

      const entry: CachedDiagnosis = {
        id: submissionId,
        timestamp: ts,
        snapshotCount: snapshots.length,
        cards: newCards,
        windows,
      };
      localStorage.setItem(rcaStorageKey(submissionId), JSON.stringify(entry));
      return entry;
    });
  }, [snapshots, submissionId]);

  if (!submissionId) return null;

  const liveWindows = snapshots.map((s, i) => snapshotToWindow(i + 1, s));
  const displayRun = diagnosis && diagnosis.id === submissionId
    ? { ...diagnosis, windows: liveWindows.length > 0 ? liveWindows : diagnosis.windows }
    : liveWindows.length > 0
      ? {
          id: submissionId,
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
          snapshotCount: liveWindows.length,
          cards: liveWindows.length >= 3 ? diagnose(snapshots) : [],
          windows: liveWindows,
        }
      : null;

  if (!displayRun || (displayRun.cards.length === 0 && displayRun.windows.length === 0)) return null;

  return (
    <section className="diag-panel" id="diagnosis-panel">
      <h3 className="section-label">Root Cause Analysis</h3>
      <div className="diag-scroll">
        <div className="diag-run">
          <div className="diag-run-header">
            <span className="mono diag-run-id">{displayRun.id.slice(0, 8)}</span>
            <span className="diag-run-meta">{displayRun.snapshotCount} windows · {displayRun.timestamp}</span>
          </div>

          {displayRun.cards.length > 0 && (
            <div className="diag-cards">
              {displayRun.cards.map(c => (
                <div key={c.id} className={`diag-card diag-card--${c.severity}`}>
                  <SeverityChip s={c.severity} />
                  <span className="diag-card-title">{c.title}</span>
                  <span className="diag-card-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          )}

          {displayRun.windows.length > 0 && (
            <div className="diag-windows">
              <div className="diag-windows-title">
                Window Breakdown ({displayRun.windows.length})
              </div>
              <div className="diag-windows-list">
                {displayRun.windows.map(w => (
                  <div key={w.windowNum} className="diag-window-row">
                    <span className="diag-window-label">W{w.windowNum}</span>
                    <span className="diag-window-time">{w.timestamp}</span>
                    <span className="diag-window-stat">TPS={w.tps.toFixed(0)}</span>
                    <span className="diag-window-stat">P99={w.p99LatencyMs.toFixed(0)}ms</span>
                    <span className="diag-window-stat">Err={w.errorPct.toFixed(1)}%</span>
                    <span className="diag-window-stat">OK={w.successCount}</span>
                    <span className="diag-window-stat">Timeout={w.timeoutCount}</span>
                    <span className="diag-window-stat">Cor={w.correctnessPct.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
