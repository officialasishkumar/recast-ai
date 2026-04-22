package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/officialasishkumar/recast-ai/pkg/auth"
	"github.com/officialasishkumar/recast-ai/pkg/config"
)

type ctxKey int

const claimsKey ctxKey = 1

// ClaimsFromContext retrieves the JWT claims stored in the request context.
// Returns nil if no claims are present.
func ClaimsFromContext(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	return c
}

// WithClaims returns a copy of ctx with the given Claims attached. It is
// intended for tests and for internal callers that set claims outside the
// JWTAuth middleware path.
func WithClaims(ctx context.Context, c *auth.Claims) context.Context {
	return context.WithValue(ctx, claimsKey, c)
}

// JWTAuth returns middleware that validates the Bearer token in the
// Authorization header using the provided Auth configuration. On success the
// parsed Claims are stored in the request context; on failure a 401 JSON
// response is returned.
func JWTAuth(cfg config.Auth) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hdr := r.Header.Get("Authorization")
			if hdr == "" {
				writeJSON(w, http.StatusUnauthorized, errorBody("missing authorization header"))
				return
			}

			parts := strings.SplitN(hdr, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				writeJSON(w, http.StatusUnauthorized, errorBody("invalid authorization format"))
				return
			}

			claims, err := auth.ValidateToken(cfg.JWTSecret, parts[1])
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, errorBody("invalid or expired token"))
				return
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole returns middleware that checks whether the authenticated user
// holds one of the listed roles. It must be placed after JWTAuth in the
// middleware chain.
func RequireRole(allowed ...string) func(http.Handler) http.Handler {
	set := make(map[string]struct{}, len(allowed))
	for _, r := range allowed {
		set[r] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := ClaimsFromContext(r.Context())
			if claims == nil {
				writeJSON(w, http.StatusUnauthorized, errorBody("authentication required"))
				return
			}
			if _, ok := set[claims.Role]; !ok {
				writeJSON(w, http.StatusForbidden, errorBody("insufficient permissions"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
