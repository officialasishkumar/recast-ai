package middleware

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// RoleLimits maps a user role to the maximum number of requests allowed per
// window (1 minute). Roles not present in the map inherit the "free" limit.
type RoleLimits map[string]int

// DefaultRoleLimits returns the standard rate-limit configuration.
func DefaultRoleLimits() RoleLimits {
	return RoleLimits{
		"free":  60,
		"guest": 60,
		"pro":   600,
		"admin": 600,
	}
}

// RateLimiter returns middleware that enforces a per-user token-bucket style
// rate limit backed by Redis. Each user key is an INCR counter with a 1-minute
// TTL (sliding window approximation). Unauthenticated requests are keyed by
// remote IP and receive the "free" limit.
func RateLimiter(rdb *redis.Client, limits RoleLimits, logger *slog.Logger) func(http.Handler) http.Handler {
	window := 60 * time.Second

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var identity string
			role := "free"

			if claims := ClaimsFromContext(r.Context()); claims != nil {
				identity = claims.UserID
				role = claims.Role
			} else {
				identity = r.RemoteAddr
			}

			limit, ok := limits[role]
			if !ok {
				limit = limits["free"]
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

			// Set the TTL only on the first increment (count == 1).
			if count == 1 {
				if err := rdb.Expire(ctx, key, window).Err(); err != nil {
					logger.Error("rate limiter redis EXPIRE failed", "error", err)
				}
			}

			// Write informational rate-limit headers.
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
