import { useEffect, useRef, useState } from 'react';
import type { SubmissionStatus } from '../types/api';
interface StageInfo {
  title: string;
  description: string;
}

const STAGE_INFO: Record<SubmissionStatus | 'idle', StageInfo[]> = {
  idle: [
    {
      title: 'Ready to evaluate',
      description: 'Upload a ZIP containing your exchange server. We support any language — Go, Java, Python, Rust, Node. Your server must listen on port 8080.',
    },
  ],
  UPLOADED: [
    {
      title: 'Validating archive',
      description: 'Checking your ZIP for a valid Dockerfile and that it can bind to port 8080. Malformed archives are rejected here.',
    },
    {
      title: 'Archive accepted',
      description: 'Your code reached the build queue. A sandbox-engine worker has claimed it and will start compiling now.',
    },
  ],
  BUILDING: [
    {
      title: 'Compiling your image',
      description: 'Docker is building your image in an isolated environment. Build logs are captured — if the build fails, the error message will show here.',
    },
    {
      title: 'Build in progress',
      description: 'This can take 30–120s for first builds. Subsequent runs with the same base image are faster due to layer caching.',
    },
    {
      title: 'Sandboxed build',
      description: 'Your build runs without network access. Dependencies must be vendored or bundled. No outbound connections are allowed during compilation.',
    },
  ],
  RUNNING: [
    {
      title: 'Container starting',
      description: 'Your exchange server is booting inside a resource-constrained container: 2 vCPU, 512 MB RAM. We wait for your HTTP server to respond before starting the load test.',
    },
    {
      title: 'Warm-up phase',
      description: 'We send a gentle trickle of orders first. This lets JVM/V8 engines JIT-compile hot paths before the real load hits.',
    },
  ],
  BENCHMARKING: [
    {
      title: 'Ramp phase',
      description: 'TPS is climbing from 50 to 500 req/s across 5 bot types: MarketMaker, FatFinger, RapidCancelReplace, SmartTrader, SpreadArb. Each sends a mix of limit, market, and cancel orders.',
    },
    {
      title: 'Sustained load',
      description: 'Peak TPS is held constant. Your order book is under maximum concurrent pressure. P99 latency here directly drives your latency score.',
    },
    {
      title: 'Spike phase',
      description: 'We 3x the TPS for 30 seconds. This tests your queue depth, backpressure handling, and whether you can shed load gracefully without cascading failures.',
    },
    {
      title: 'Drain phase',
      description: 'Load drops to zero. We verify correctness — final order book state, trade ledger, and fill accuracy are validated against a reference implementation.',
    },
  ],
  SCORED: [
    {
      title: 'Scoring complete',
      description: 'Score = 40% throughput + 40% latency + 20% correctness. Correctness below 30% results in disqualification regardless of speed.',
    },
  ],
  FAILED: [
    {
      title: 'Pipeline failed',
      description: 'Your submission failed during build or runtime. Check the error message above. Common causes: build timeout (>5 min), port binding failure, or crash within the first 10 seconds.',
    },
  ],
};

interface BenchmarkStageInfoProps {
  currentStatus: SubmissionStatus | null;
}

export function BenchmarkStageInfo({ currentStatus }: BenchmarkStageInfoProps) {
  const key = currentStatus ?? 'idle';
  const messages = STAGE_INFO[key] ?? STAGE_INFO['idle'];
  const [index, setIndex] = useState(0);
  const indexStageRef = useRef(key);

  // Reset rotation immediately when the pipeline stage changes so we never
  // read messages[index] with a stale index from the previous stage.
  if (indexStageRef.current !== key) {
    indexStageRef.current = key;
    setIndex(0);
  }

  const safeIndex = messages.length > 0 ? index % messages.length : 0;
  const message = messages[safeIndex] ?? messages[0] ?? STAGE_INFO.idle[0];

  useEffect(() => {
    setIndex(0);
    if (messages.length <= 1) return;
    const t = setInterval(() => {
      setIndex(i => (i + 1) % messages.length);
    }, 4000);
    return () => clearInterval(t);
  }, [key, messages.length]);

  const { title, description } = message;
  return (
    <div className="stage-info" id="stage-info">
      <span className="stage-info-title">{title}</span>
      <span className="stage-info-desc">{description}</span>
    </div>
  );
}
