import { useCallback, useEffect, useRef, useState } from 'react';

import { getSubmissionHistory, getSubmissionResults, getSubmissionStatus, uploadSubmission } from '../api/client';

import { CopyButton } from '../components/CopyButton';
import { ErrorBanner } from '../components/ErrorBanner';
import { EventLog } from '../components/EventLog';
import { DiagnosisPanel } from '../components/DiagnosisPanel';
import { MetricsChart } from '../components/MetricsChart';
import { MetricsPanel } from '../components/MetricsPanel';
import { SubmissionPipeline } from '../components/PipelineTracker';
import { StatusPill } from '../components/StatusPill';
import { showToast } from '../components/Toast';
import { UploadForm } from '../components/UploadForm';
import type { UploadFormData } from '../components/UploadForm';
import { useSubmissionStatus } from '../hooks/useSubmissionStatus';
import type { MetricSnapshot, Score, Submission } from '../types/api';


export function SubmitPage() {
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [teamToken, setTeamToken] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MetricSnapshot | null>(null);
  const [score, setScore] = useState<Score | null>(null);
  const [history, setHistory] = useState<MetricSnapshot[]>([]);

  const lastSubmissionRef = useRef<Submission | null>(null);

  const handleStaleSession = useCallback(() => {
    const prevId = localStorage.getItem('bench_submission_id');
    if (prevId) {
      localStorage.removeItem(`bench_rca_${prevId}`);
      localStorage.removeItem(`bench_logs_${prevId}`);
    }
    localStorage.removeItem('bench_rca_history');
    localStorage.removeItem('bench_submission_id');
    localStorage.removeItem('bench_team_token');
    setSubmissionId(null);
    setTeamToken('');
    setSnapshot(null);
    setScore(null);
    setHistory([]);
    lastSubmissionRef.current = null;
  }, []);

  // Restore a saved session only if the submission still exists in the backend.
  // After a DB wipe the old localStorage id is silently discarded — no error banner.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const storedId = localStorage.getItem('bench_submission_id');
      const storedToken = localStorage.getItem('bench_team_token') ?? '';

      if (!storedId || !storedToken) {
        if (!cancelled) setSessionReady(true);
        return;
      }

      try {
        await getSubmissionStatus(storedId, storedToken);
        if (!cancelled) {
          setSubmissionId(storedId);
          setTeamToken(storedToken);
          setSessionReady(true);
        }
      } catch {
        if (!cancelled) {
          handleStaleSession();
          setSessionReady(true);
        }
      }
    };

    void restore();
    return () => { cancelled = true; };
  }, [handleStaleSession]);

  const { submission, phase, error: pollError } = useSubmissionStatus(
    sessionReady ? submissionId : null,
    teamToken,
    { onNotFound: handleStaleSession },
  );

  // Latch: once we have a submission object, keep it visible even during
  // brief phase transitions so the UI never goes blank.
  if (submission !== null) lastSubmissionRef.current = submission;
  // If there's no active submissionId (e.g. after reset), ignore the latch entirely.
  const displaySubmission = submissionId ? (submission ?? lastSubmissionRef.current) : null;

  const handleUpload = useCallback(async (data: UploadFormData) => {
    setUploadLoading(true);
    setUploadError(null);
    try {
      const result = await uploadSubmission(data);
      setSubmissionId(result.submissionId);
      setTeamToken(data.token);
      localStorage.setItem('bench_submission_id', result.submissionId);
      localStorage.setItem('bench_team_token', data.token);
      localStorage.removeItem('bench_rca_history');
      setSnapshot(null);
      setScore(null);
      showToast('success', `Submission created: ${result.submissionId.slice(0, 8)}…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
      showToast('error', msg);
    } finally {
      setUploadLoading(false);
    }
  }, []);

  const handleReset = useCallback(() => {
    const prevId = localStorage.getItem('bench_submission_id');
    if (prevId) {
      localStorage.removeItem(`bench_rca_${prevId}`);
      localStorage.removeItem(`bench_logs_${prevId}`);
    }
    localStorage.removeItem('bench_rca_history');
    setSubmissionId(null);
    setTeamToken('');
    localStorage.removeItem('bench_submission_id');
    localStorage.removeItem('bench_team_token');
    setUploadError(null);
    setSnapshot(null);
    setScore(null);
    setHistory([]);
    lastSubmissionRef.current = null;
    window.location.replace(window.location.pathname);
  }, []);

  // Metrics polling: driven by submissionId + teamToken only.
  // phase is read via ref so changing phase never tears this effect down mid-flight.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    if (!submissionId || !teamToken) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const currentPhase = phaseRef.current;
      if (currentPhase !== 'polling' && currentPhase !== 'success') return;

      const [resultsResult, historyResult] = await Promise.allSettled([
        getSubmissionResults(submissionId, teamToken),
        getSubmissionHistory(submissionId, teamToken),
      ]);

      if (cancelled) return;

      if (resultsResult.status === 'fulfilled' && resultsResult.value.snapshot) {
        setSnapshot(resultsResult.value.snapshot);
        if (resultsResult.value.score) setScore(resultsResult.value.score);
      }
      if (historyResult.status === 'fulfilled' && historyResult.value?.length > 0) {
        setHistory(historyResult.value);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [submissionId, teamToken]); // phase intentionally excluded — read via ref

  // Note: No auto-reset timer. The user explicitly clicks "Submit another"
  // or "Retry" to start a fresh submission.

  const isTerminal = phase === 'success' || phase === 'failed' || phase === 'timeout';
  const hasSubmission = displaySubmission !== null;
  const showPipelineError =
    hasSubmission &&
    ((phase === 'failed' && displaySubmission!.status === 'FAILED') || phase === 'timeout');

  return (
    <div className="submit-page">
      <div className="submit-layout">
        {/* Left column */}
        <div className="submit-left">
          {!hasSubmission && (
            <UploadForm onSubmit={handleUpload} loading={uploadLoading} error={uploadError} />
          )}

          {hasSubmission && (
            <div className="panel sub-card" id="submission-details">
              <h3 className="section-label">Submission Details</h3>
              <div className="sub-row">
                <span className="sub-key">ID</span>
                <span className="sub-val mono">
                  {displaySubmission!.id.slice(0, 12)}…
                  <CopyButton text={displaySubmission!.id} label="Copy submission ID" />
                </span>
              </div>
              <div className="sub-row">
                <span className="sub-key">Team</span>
                <span className="sub-val">{displaySubmission!.teamName}</span>
              </div>
              <div className="sub-row">
                <span className="sub-key">Status</span>
                <StatusPill status={displaySubmission!.status} />
              </div>
              <div className="sub-row">
                <span className="sub-key">Uploaded</span>
                <span className="sub-val mono">{new Date(displaySubmission!.uploadedAt).toLocaleTimeString()}</span>
              </div>
              {displaySubmission!.benchmarkStart && (
                <div className="sub-row">
                  <span className="sub-key">Bench start</span>
                  <span className="sub-val mono">{new Date(displaySubmission!.benchmarkStart).toLocaleTimeString()}</span>
                </div>
              )}
              {displaySubmission!.benchmarkEnd && (
                <div className="sub-row">
                  <span className="sub-key">Bench end</span>
                  <span className="sub-val mono">{new Date(displaySubmission!.benchmarkEnd).toLocaleTimeString()}</span>
                </div>
              )}
              {displaySubmission!.errorMessage && (
                <div className="sub-error">{displaySubmission!.errorMessage}</div>
              )}
              {isTerminal && (
                <button className="reset-btn" onClick={handleReset} type="button" id="reset-btn">
                  ← Submit another
                </button>
              )}
            </div>
          )}

          {/* Event log — only when submission is active */}
          {hasSubmission && (
            <EventLog
              status={displaySubmission!.status}
              submissionId={displaySubmission!.id}
              history={history}
              score={score}
            />
          )}
        </div>

        {/* Right column */}
        <div className="submit-right">
          <SubmissionPipeline currentStatus={hasSubmission ? displaySubmission!.status : null} />

          {showPipelineError && (
            <ErrorBanner
              title={phase === 'timeout' ? 'Polling Timed Out' : 'Benchmark Failed'}
              message={displaySubmission?.errorMessage ?? pollError ?? 'An unexpected error occurred during the benchmark pipeline.'}
              detail={pollError ?? undefined}
              onRetry={handleReset}
            />
          )}

          <MetricsPanel snapshot={snapshot} score={score} />

          {history.length >= 2 && (
            <MetricsChart snapshots={history} />
          )}
        </div>
      </div>

      <DiagnosisPanel snapshots={history} submissionId={submissionId} />
    </div>
  );
}
