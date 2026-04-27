package resilience

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/sony/gobreaker"
)

func TestDo_FirstAttemptSucceeds(t *testing.T) {
	t.Parallel()

	calls := 0
	err := Do(context.Background(), func() error {
		calls++
		return nil
	}, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if calls != 1 {
		t.Errorf("expected 1 call, got %d", calls)
	}
}

func TestDo_RetriesUntilSuccess(t *testing.T) {
	t.Parallel()

	calls := 0
	err := Do(context.Background(), func() error {
		calls++
		if calls < 3 {
			return errors.New("transient")
		}
		return nil
	}, 5, time.Millisecond)
	if err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if calls != 3 {
		t.Errorf("expected 3 calls, got %d", calls)
	}
}

func TestDo_ExhaustsAttempts(t *testing.T) {
	t.Parallel()

	calls := 0
	err := Do(context.Background(), func() error {
		calls++
		return errors.New("boom")
	}, 3, time.Millisecond)
	if err == nil {
		t.Fatal("expected error after exhaustion")
	}
	if calls != 3 {
		t.Errorf("expected 3 calls, got %d", calls)
	}
}

func TestDo_ContextCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := Do(ctx, func() error { return errors.New("ignored") }, 5, time.Millisecond)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
}

func TestDo_NilOpReturnsError(t *testing.T) {
	t.Parallel()
	if err := Do(context.Background(), nil, 3, time.Millisecond); err == nil {
		t.Error("expected error for nil op")
	}
}

func TestDo_NormalisesAttemptsAndBackoff(t *testing.T) {
	t.Parallel()
	calls := 0
	err := Do(context.Background(), func() error {
		calls++
		return nil
	}, 0, 0)
	if err != nil || calls != 1 {
		t.Errorf("expected single call success, got calls=%d err=%v", calls, err)
	}
}

func TestNewBreaker_DefaultsApplied(t *testing.T) {
	t.Parallel()

	cb := New("test", BreakerOpts{})
	if cb.Name() != "test" {
		t.Errorf("expected name 'test', got %q", cb.Name())
	}
	if cb.State() != gobreaker.StateClosed {
		t.Errorf("expected breaker to start Closed, got %v", cb.State())
	}

	// Drive the breaker through a successful execution to make sure the
	// settings tuple is actually wired up and callable.
	_, err := cb.Execute(func() (any, error) { return "ok", nil })
	if err != nil {
		t.Fatalf("execute failed: %v", err)
	}
}

func TestNewBreaker_OpensOnRepeatedFailures(t *testing.T) {
	t.Parallel()

	cb := New("flaky", BreakerOpts{
		MaxRequests:  1,
		Interval:     time.Hour,
		Timeout:      time.Hour,
		FailureRatio: 0.5,
		MinRequests:  4,
	})

	for i := 0; i < 6; i++ {
		_, _ = cb.Execute(func() (any, error) { return nil, errors.New("nope") })
	}
	if cb.State() != gobreaker.StateOpen {
		t.Errorf("expected breaker to be Open after sustained failures, got %v", cb.State())
	}
}
