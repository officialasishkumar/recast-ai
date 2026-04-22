package middleware

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// DefaultLimit returns the per-minute request limit used by the gateway. It
// reads the RATE_LIMIT_PER_MIN env var and falls back to 60.
func DefaultLimit() int {
	if v := os.Getenv("RATE_LIMIT_PER_MIN"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 60
}

// RateLimiter returns middleware that enforces a single global per-user
// token-bucket rate limit backed by Redis. Each key is an INCR counter with a
// one-minute TTL (sliding-window approximation). Unauthenticated requests are
// keyed by remote IP.
func RateLimiter(rdb *redis.Client, limit int, logger *slog.Logger) func(http.Handler) http.Handler {
	if limit <= 0 {
		limit = 60
	}
	window := 60 * time.Second

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var identity string
			if claims := ClaimsFromContext(r.Context()); claims != nil {
				identity = claims.UserID
			} else {
				identity = r.RemoteAddr
			}

			key := fmt.Sprintf("ratelimit:%s", identity)

			ctx := r.Context()
			count, err := rdb.Incr(ctx, key).Result()
			if err != nil {
				logger.Error("rate limiter redis INCR failed", "error", err)
				// Fail open: allow the request if Redis is unreachable.
				next.ServeHTTP(w, r)
				return
			}

			if count == 1 {
				if err := rdb.Expire(ctx, key, window).Err(); err != nil {
					logger.Error("rate limiter redis EXPIRE failed", "error", err)
				}
			}

			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
			remaining := limit - int(count)
			if remaining < 0 {
				remaining = 0
			}
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))

			ttl, err := rdb.TTL(ctx, key).Result()
			if err == nil && ttl > 0 {
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(ttl).Unix(), 10))
			}

			if int(count) > limit {
				w.Header().Set("Retry-After", "60")
				writeJSON(w, http.StatusTooManyRequests, errorBody("rate limit exceeded"))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// --- helpers shared across the middleware package ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func errorBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}
