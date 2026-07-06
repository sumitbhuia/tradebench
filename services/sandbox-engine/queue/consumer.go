package queue

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	gen "github.com/bench/shared/proto/gen"
	"github.com/bench/sandbox-engine/runner"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

)

const (
	jobStreamKey  = "stream:jobs"
	consumerGroup = "sandbox-engine"
	consumerName  = "sandbox-engine-1"
	blockDuration = 5 * time.Second
	botFleetAddr  = "dns:///bot-fleet:9002"

	statusKeyTTL = time.Hour

	// pelMinIdle is how long a message must sit unacked in the PEL before this
	// consumer instance reclaims it from a previous (now-dead) instance.
	pelMinIdle = 30 * time.Second
)

// StatusUpdater is the interface the consumer uses to update submission state.
// PostgresStatusUpdater satisfies this interface.
type StatusUpdater interface {
	UpdateStatus(ctx context.Context, submissionID, status, errMsg string) error
	UpdateImageAndContainer(ctx context.Context, submissionID, imageTag, containerID string, containerPort int) error
}

// Consumer reads jobs from the Redis stream and drives each submission through
// the Build → Spawn → HealthCheck.
type Consumer struct {
	rdb          *redis.Client
	builder      *runner.Builder
	spawner      *runner.Spawner
	health       *runner.HealthChecker
	db           StatusUpdater
	registry     *runner.Registry
	sem          chan struct{} // concurrency limiter
	buildTimeout time.Duration
}

func NewConsumer(
	rdb *redis.Client,
	builder *runner.Builder,
	spawner *runner.Spawner,
	health *runner.HealthChecker,
	db StatusUpdater,
	registry *runner.Registry,
	maxConcurrent int,
	buildTimeoutSec int,
) *Consumer {
	if maxConcurrent <= 0 {
		maxConcurrent = 1
	}
	if buildTimeoutSec <= 0 {
		buildTimeoutSec = 120
	}
	return &Consumer{
		rdb:          rdb,
		builder:      builder,
		spawner:      spawner,
		health:       health,
		db:           db,
		registry:     registry,
		sem:          make(chan struct{}, maxConcurrent),
		buildTimeout: time.Duration(buildTimeoutSec) * time.Second,
	}
}

// ensureGroup creates the consumer group if it does not exist.
// use "$" so a freshly-created group only sees messages that arrive after

// if the group already exists the BUSYGROUP error is swallowed;
// the existing last-delivered-ID is unchanged.
func (c *Consumer) ensureGroup(ctx context.Context) error {
	err := c.rdb.XGroupCreateMkStream(ctx, jobStreamKey, consumerGroup, "$").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return fmt.Errorf("consumer: create group: %w", err)
	}
	return nil
}

// reclaimPEL reclaims messages that have been sitting in the Pending Entry
func (c *Consumer) reclaimPEL(ctx context.Context) {
	for {
		res, _, err := c.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream:   jobStreamKey,
			Group:    consumerGroup,
			Consumer: consumerName,
			MinIdle:  pelMinIdle,
			Start:    "0-0",
			Count:    10,
		}).Result()
		if err != nil {
			// NOGROUP can appear here on the very first startup before the group exists
			slog.Error("consumer: xautoclaim error", "err", err)
			return
		}
		if len(res) == 0 {
			return // PEL is empty or all entries are too fresh
		}
		slog.Info("consumer: reclaiming stale PEL messages", "count", len(res))
		for _, msg := range res {
			c.dispatch(ctx, msg)
		}
	}
}

// Run is the main loop. It blocks until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	// ensureGroup is idempotent: safe to call every startup.
	if err := c.ensureGroup(ctx); err != nil {
		return err
	}

	// reclaim any messages that were left unacked by a previous instance.
	c.reclaimPEL(ctx)

	slog.Info("consumer: listening",
		"stream", jobStreamKey,
		"group", consumerGroup,
		"maxConcurrent", cap(c.sem),
		"buildTimeoutSec", c.buildTimeout.Seconds(),
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		streams, err := c.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: consumerName,
			Streams:  []string{jobStreamKey, ">"},
			Count:    1,
			Block:    blockDuration,
		}).Result()
		if err != nil {
			if err == redis.Nil {
				continue // block timeout, no new messages — normal
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}

			if strings.Contains(err.Error(), "NOGROUP") {
				slog.Warn("consumer: group missing, recreating", "err", err)
				if recreateErr := c.ensureGroup(ctx); recreateErr != nil {
					slog.Error("consumer: failed to recreate group", "err", recreateErr)
				}
				time.Sleep(time.Second)
				continue
			}
			slog.Error("consumer: xreadgroup error", "err", err)
			time.Sleep(time.Second)
			continue
		}

		for _, stream := range streams {
			for _, msg := range stream.Messages {
				c.dispatch(ctx, msg)
			}
		}
	}
}

// dispatch acquires a concurrency slot and processes msg in a goroutine.
func (c *Consumer) dispatch(ctx context.Context, msg redis.XMessage) {
	// acquire concurrency slot from semaphore  — blocks if at capacity.
	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return
	}

	go func(m redis.XMessage) {
		defer func() { <-c.sem }()

		if err := c.process(ctx, m); err != nil {
			slog.Error("consumer: process failed", "msgId", m.ID, "err", err)
			return // leave in PEL; reclaimPEL will pick it up on next restart
		}
		if err := c.rdb.XAck(ctx, jobStreamKey, consumerGroup, m.ID).Err(); err != nil {
			slog.Error("consumer: xack failed", "msgId", m.ID, "err", err)
		}
	}(msg)
}

func (c *Consumer) process(ctx context.Context, msg redis.XMessage) error {
	vals := msg.Values
	submissionID, _ := vals["submissionId"].(string)
	zipPath, _ := vals["zipPath"].(string)

	if submissionID == "" || zipPath == "" {
		return fmt.Errorf("consumer: missing submissionId or zipPath in message %s", msg.ID)
	}

	imageTag := "bench-submission-" + submissionID

	// ── BUILDING ─────────────────────────────────────────────────────────────
	c.setStatus(ctx, submissionID, "BUILDING", "")

	buildCtx, buildCancel := context.WithTimeout(ctx, c.buildTimeout)
	defer buildCancel()

	if err := c.builder.Build(buildCtx, zipPath, imageTag); err != nil {
		c.setStatus(ctx, submissionID, "FAILED", err.Error())
		return fmt.Errorf("consumer: build: %w", err)
	}

	// ── RUNNING — spawn container ─────────────────────────────────────────────
	c.setStatus(ctx, submissionID, "RUNNING", "")

	containerID, port, err := c.spawner.Spawn(imageTag, submissionID)
	if err != nil {
		c.setStatus(ctx, submissionID, "FAILED", err.Error())
		return fmt.Errorf("consumer: spawn: %w", err)
	}

	// write image_tag, container_id, container_port to Postgres .
	if err := c.db.UpdateImageAndContainer(ctx, submissionID, imageTag, containerID, port); err != nil {
		// log for observability
		slog.Error("consumer: UpdateImageAndContainer failed",
			"submissionId", submissionID,
			"err", err,
		)
	}

	// register before health check so the watchdog can clean up on timeout.
	c.registry.Add(submissionID, containerID, port, time.Now())

	// ── HEALTH CHECK ─────────────────────────────────────────────────────────
	if err := c.health.WaitReady(ctx, containerID); err != nil {
		c.setStatus(ctx, submissionID, "FAILED", "health check failed: "+err.Error())
		c.registry.Remove(submissionID)
		return fmt.Errorf("consumer: health: %w", err)
	}

	// ── BENCHMARKING ──────────────────
	c.setStatus(ctx, submissionID, "BENCHMARKING", "")

	targetHost := fmt.Sprintf("submission-%s:8080", shortID(submissionID))

	conn, err := grpc.NewClient(botFleetAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		slog.Error("trigger: grpc dial failed", "submissionId", submissionID, "err", err)
		c.setStatus(ctx, submissionID, "FAILED", "benchmark start failed: "+err.Error())
		return fmt.Errorf("consumer: grpc dial: %w", err)
	}
	defer conn.Close()

	client := gen.NewBotFleetClient(conn)
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err = client.StartBenchmark(callCtx, &gen.BenchmarkConfig{
		SubmissionId: submissionID,
		TargetHost:  targetHost,
	})
	if err != nil {
		slog.Error("trigger: StartBenchmark failed", "submissionId", submissionID, "err", err)
		c.setStatus(ctx, submissionID, "FAILED", "benchmark start failed: "+err.Error())
		return fmt.Errorf("consumer: start benchmark: %w", err)
	}
	slog.Info("trigger: benchmark started", "submissionId", submissionID, "targetHost", targetHost)

	slog.Info("consumer: container ready",
		"submissionId", submissionID,
		"containerID", containerID,
		"port", port,
		"imageTag", imageTag,
	)
	return nil
}

// setStatus updates both Postgres and the Redis submission:{id}:status key.
func (c *Consumer) setStatus(ctx context.Context, submissionID, status, errMsg string) {
	if err := c.db.UpdateStatus(ctx, submissionID, status, errMsg); err != nil {
		slog.Error("consumer: UpdateStatus failed",
			"submissionId", submissionID,
			"status", status,
			"err", err,
		)
	}

	// write Redis cache key: submission:{id}:status (PRD Section 4.4, TTL 1h).
	redisKey := "submission:" + submissionID + ":status"
	if err := c.rdb.Set(ctx, redisKey, status, statusKeyTTL).Err(); err != nil {
		slog.Error("consumer: redis SetStatus failed",
			"submissionId", submissionID,
			"status", status,
			"err", err,
		)
	}

	// Notify the leaderboard SSE stream when a submission fails so connected
	// browsers see the entry appear in the "Failing" tab immediately.
	if status == "FAILED" {
		if err := c.rdb.Publish(ctx, "channel:leaderboard", "status_change").Err(); err != nil {
			slog.Error("consumer: redis Publish leaderboard failed",
				"submissionId", submissionID,
				"err", err,
			)
		}
	}
}

// shortID returns the first 8 chars of a UUID (matches container naming convention).
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
