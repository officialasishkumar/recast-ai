package resilience

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"
)

// Do executes op up to attempts times, waiting an exponentially increasing,
// jittered duration seeded by backoff between attempts. It returns nil on the
// first successful invocation, ctx.Err() if the context is cancelled, or the
// last error returned by op once attempts are exhausted.
//
// attempts must be at least 1; values less than 1 are coerced to 1.
func Do(ctx context.Context, op func() error, attempts int, backoff time.Duration) error {
	if op == nil {
		return errors.New("resilience: nil op")
	}
	if attempts < 1 {
		attempts = 1
	}
	if backoff <= 0 {
		backoff = 100 * time.Millisecond
	}

	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		lastErr = op()
		if lastErr == nil {
			return nil
		}

		if attempt == attempts-1 {
			break
		}

		delay := backoff << attempt
		jitter := time.Duration(rand.Int64N(int64(delay) / 2))
		wait := delay + jitter

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}

	return fmt.Errorf("resilience: exhausted %d attempts: %w", attempts, lastErr)
}
