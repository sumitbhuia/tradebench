import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, getSubmissionStatus } from '../api/client';
import type { Submission, SubmissionStatus } from '../types/api';

/** Phases the polling lifecycle can be in. */
export type PollingPhase =
  | 'idle'
  | 'loading'
  | 'polling'
  | 'success'
  | 'failed'
  | 'timeout';

export interface SubmissionStatusState {
  /** Latest submission snapshot returned by the API. */
  submission: Submission | null;
  /** Current lifecycle phase. */
  phase: PollingPhase;
  /** Human-readable error message, if any. */
  error: string | null;
}

interface PollingOptions {
  /** Milliseconds between polls. @default 2000 */
  intervalMs?: number;
  /** Maximum milliseconds before the hook declares a timeout. @default 300_000 (5 min) */
  timeoutMs?: number;
  /** Called when the API returns 404 — submission no longer exists (stale local session). */
  onNotFound?: () => void;
}

/** Terminal statuses that should stop the polling loop. */
const TERMINAL_STATUSES: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>([
  'SCORED',
  'FAILED',
]);

/**
 * Polls `GET /api/submissions/:id/status` and exposes a phase-aware state
 * object for UI consumption.
 *
 * The hook transitions through a well-defined lifecycle:
 *   idle → loading → polling → success | failed | timeout
 *
 * Polling stops automatically when the submission reaches a terminal status
 * (SCORED or FAILED) or when the configurable timeout elapses.
 */
export function useSubmissionStatus(
  submissionId: string | null,
  token: string,
  options?: PollingOptions,
): SubmissionStatusState {
  const intervalMs = options?.intervalMs ?? 2_000;
  const timeoutMs = options?.timeoutMs ?? 300_000;
  const onNotFoundRef = useRef(options?.onNotFound);
  onNotFoundRef.current = options?.onNotFound;

  const [submission, setSubmission] = useState<Submission | null>(null);
  const [phase, setPhase] = useState<PollingPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  // Track the start time for timeout calculation.
  const startRef = useRef<number>(0);

  // Track consecutive errors to avoid killing the UI on a single failed fetch.
  const consecutiveErrorsRef = useRef<number>(0);
  const MAX_CONSECUTIVE_ERRORS = 5;

  const poll = useCallback(
    async (id: string, tk: string): Promise<boolean> => {
      try {
        const next = await getSubmissionStatus(id, tk);
        consecutiveErrorsRef.current = 0; // reset on success
        setSubmission(next);
        setError(null);

        if (TERMINAL_STATUSES.has(next.status)) {
          setPhase(next.status === 'SCORED' ? 'success' : 'failed');
          return false; // stop polling
        }

        // Check for timeout.
        if (Date.now() - startRef.current >= timeoutMs) {
          setPhase('timeout');
          setError('Status polling timed out');
          return false; // stop polling
        }

        setPhase('polling');
        return true; // continue polling
      } catch (err) {
        // Stale session — submission was deleted or DB was reset; don't show failure UI.
        const isStale =
          (err instanceof ApiError && (err.status === 404 || err.code === 'NOT_FOUND')) ||
          (err instanceof Error && err.message.toLowerCase().includes('not found'));

        if (isStale) {
          consecutiveErrorsRef.current = 0;
          setSubmission(null);
          setPhase('idle');
          setError(null);
          onNotFoundRef.current?.();
          return false;
        }

        consecutiveErrorsRef.current += 1;
        const msg = err instanceof Error ? err.message : 'Unable to load submission status';
        setError(msg);

        // Only give up after multiple consecutive errors, not on the first one.
        // During build/sandbox phases the API may briefly 404 or 500.
        if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
          setPhase('failed');
          return false; // stop polling
        }

        // Keep polling — transient error.
        return true;
      }
    },
    [timeoutMs],
  );

  useEffect(() => {
    if (!submissionId || !token) {
      setSubmission(null);
      setPhase('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    startRef.current = Date.now();
    setPhase('loading');

    const tick = async () => {
      if (cancelled) return;
      const shouldContinue = await poll(submissionId, token);
      if (!cancelled && shouldContinue) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [submissionId, token, intervalMs, poll]);

  return { submission, phase, error };
}
