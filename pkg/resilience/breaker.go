// Package resilience wraps standard patterns (circuit breaker, retry with
// exponential backoff) used by every Recast AI Go service.
package resilience

import (
	"time"

	"github.com/sony/gobreaker"
)

// BreakerOpts captures the tunable parameters of a circuit breaker without
// exposing gobreaker internals to callers.
type BreakerOpts struct {
	// MaxRequests is the number of probes allowed while half-open.
	MaxRequests uint32
	// Interval is the cyclic period over which failure counts reset in the
	// closed state. Zero disables the periodic reset.
	Interval time.Duration
	// Timeout is how long the breaker stays open before switching to half-open.
	Timeout time.Duration
	// FailureRatio opens the breaker when exceeded (0 < ratio <= 1).
	FailureRatio float64
	// MinRequests is the minimum number of requests in an interval before the
	// failure ratio is evaluated.
	MinRequests uint32
}

// New constructs a gobreaker.CircuitBreaker tagged with name using the
// supplied options. Sensible defaults are applied when zero values are
// supplied so callers can pass a partially populated BreakerOpts.
func New(name string, opts BreakerOpts) *gobreaker.CircuitBreaker {
	if opts.MaxRequests == 0 {
		opts.MaxRequests = 1
	}
	if opts.Timeout == 0 {
		opts.Timeout = 30 * time.Second
	}
	if opts.MinRequests == 0 {
		opts.MinRequests = 5
	}
	if opts.FailureRatio <= 0 || opts.FailureRatio > 1 {
		opts.FailureRatio = 0.6
	}

	settings := gobreaker.Settings{
		Name:        name,
		MaxRequests: opts.MaxRequests,
		Interval:    opts.Interval,
		Timeout:     opts.Timeout,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			if counts.Requests < opts.MinRequests {
				return false
			}
			ratio := float64(counts.TotalFailures) / float64(counts.Requests)
			return ratio >= opts.FailureRatio
		},
	}
	return gobreaker.NewCircuitBreaker(settings)
}
