# pkg/resilience

Tiny wrappers around the resilience primitives used throughout Recast AI: a circuit breaker built on `github.com/sony/gobreaker`, and a context-aware retry helper with exponential backoff and jitter. Services compose these around third-party calls (Gemini, ElevenLabs, Polly, MinIO) to keep transient faults from cascading.

## Usage

```go
cb := resilience.New("gemini", resilience.BreakerOpts{
    MaxRequests: 2,
    Timeout:     15 * time.Second,
    FailureRatio: 0.5,
    MinRequests: 10,
})

err := resilience.Do(ctx, func() error {
    _, err := cb.Execute(func() (any, error) { return client.Call(ctx) })
    return err
}, 5, 500*time.Millisecond)
```

Call `Do` when the caller controls retries and pass the breaker-wrapped call as `op`. Backoff doubles per attempt and adds up to 50 percent jitter so concurrent callers do not synchronise their retries.
