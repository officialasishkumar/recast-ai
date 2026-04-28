package middleware

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

// IdempotencyTTL bounds how long a request signature stays cached. Clients
// retrying past this window will see the operation re-executed.
const IdempotencyTTL = 24 * time.Hour

// idempotentRecord is the cached envelope persisted under an idempotency key.
type idempotentRecord struct {
	Status      int               `json:"status"`
	Body        string            `json:"body"` // base64
	ContentType string            `json:"content_type"`
	Headers     map[string]string `json:"headers,omitempty"`
}

// Idempotency returns middleware that makes mutating requests safe to retry.
// When the client supplies an Idempotency-Key header, the (user, key, route,
// body-hash) tuple is recorded in Redis along with the response. A repeat
// request returns the cached response without re-running the handler.
//
// Bodies are buffered up to maxBody bytes so the handler still sees the
// original request stream. Requests without an Idempotency-Key fall through
// untouched so existing clients keep working.
func Idempotency(rdb *redis.Client, logger *slog.Logger) func(http.Handler) http.Handler {
	const maxBody = 10 << 20 // 10 MiB; multipart uploads bypass this middleware

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("Idempotency-Key")
			if key == "" || (r.Method != http.MethodPost && r.Method != http.MethodPatch) {
				next.ServeHTTP(w, r)
				return
			}

			var userID string
			if claims := ClaimsFromContext(r.Context()); claims != nil {
				userID = claims.UserID
			} else {
				userID = "anon"
			}

			body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errorBody("read request body"))
				return
			}
			if len(body) > maxBody {
				// Body exceeds idempotency buffer; restore stream and skip caching.
				r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
				next.ServeHTTP(w, r)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))

			bodyHash := sha256.Sum256(body)
			redisKey := "idemp:" + userID + ":" + r.Method + ":" + r.URL.Path + ":" + key + ":" + hex.EncodeToString(bodyHash[:8])

			ctx := r.Context()
			if cached, err := rdb.Get(ctx, redisKey).Result(); err == nil {
				var rec idempotentRecord
				if jerr := json.Unmarshal([]byte(cached), &rec); jerr == nil {
					if rec.ContentType != "" {
						w.Header().Set("Content-Type", rec.ContentType)
					}
					for k, v := range rec.Headers {
						w.Header().Set(k, v)
					}
					w.Header().Set("Idempotent-Replay", "true")
					w.WriteHeader(rec.Status)
					if decoded, derr := base64.StdEncoding.DecodeString(rec.Body); derr == nil {
						_, _ = w.Write(decoded)
					}
					return
				}
				logger.Warn("idempotency cache decode failed", "error", err)
			}

			// Capture the handler response so we can persist it.
			rec := &recorder{ResponseWriter: w, status: http.StatusOK, headerMap: http.Header{}}
			next.ServeHTTP(rec, r)

			// Only cache success responses. 4xx/5xx are intentionally
			// re-attempted on retry.
			if rec.status >= 200 && rec.status < 300 {
				envelope := idempotentRecord{
					Status:      rec.status,
					Body:        base64.StdEncoding.EncodeToString(rec.body.Bytes()),
					ContentType: rec.Header().Get("Content-Type"),
				}
				if payload, jerr := json.Marshal(envelope); jerr == nil {
					if rerr := rdb.Set(ctx, redisKey, payload, IdempotencyTTL).Err(); rerr != nil {
						logger.Warn("idempotency cache write failed", "error", rerr)
					}
				}
			}
		})
	}
}

// recorder buffers the handler response so it can be cached. It only buffers
// the body; headers are observed through the embedded ResponseWriter.
type recorder struct {
	http.ResponseWriter
	status    int
	wroteHead bool
	body      bytes.Buffer
	headerMap http.Header
}

func (r *recorder) WriteHeader(code int) {
	if r.wroteHead {
		return
	}
	r.status = code
	r.wroteHead = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if !r.wroteHead {
		r.WriteHeader(http.StatusOK)
	}
	r.body.Write(b)
	return r.ResponseWriter.Write(b)
}
