package handler

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"github.com/officialasishkumar/recast-ai/pkg/auth"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/models"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
	"github.com/officialasishkumar/recast-ai/pkg/storage"

	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
)

// Deps groups external dependencies shared by all handlers.
type Deps struct {
	DB      *sqlx.DB
	Store   *storage.Client
	Queue   *queue.Connection
	Redis   *redis.Client
	AuthCfg config.Auth
	Logger  *slog.Logger
}

// ---------- request / response types ----------

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type googleAuthRequest struct {
	Code string `json:"code"`
}

type authResponse struct {
	Token        string      `json:"token"`
	RefreshToken string      `json:"refresh_token,omitempty"`
	User         models.User `json:"user"`
}

// ---------- handlers ----------

// Register creates a new user account with email and password.
//
//	POST /v1/auth/register
func (d *Deps) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, "email and password are required")
		return
	}
	if len(req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	// Check for existing user.
	var exists bool
	if err := d.DB.GetContext(r.Context(), &exists,
		`SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)`, req.Email); err != nil {
		d.Logger.Error("register: check existing user", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if exists {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		d.Logger.Error("register: bcrypt hash", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	user := models.User{
		ID:           uuid.New().String(),
		Email:        req.Email,
		PasswordHash: sql.NullString{String: string(hash), Valid: true},
		Name:         req.Name,
		Role:         models.RoleFree,
		MinutesQuota: 30, // default free-tier quota
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}

	_, err = d.DB.ExecContext(r.Context(),
		`INSERT INTO users (id, email, password_hash, name, role, minutes_used, minutes_quota, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		user.ID, user.Email, user.PasswordHash, user.Name, user.Role,
		user.MinutesUsed, user.MinutesQuota, user.CreatedAt, user.UpdatedAt)
	if err != nil {
		d.Logger.Error("register: insert user", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	token, err := auth.GenerateToken(d.AuthCfg.JWTSecret, user.ID, user.Email, user.Role, d.AuthCfg.JWTExpiry)
	if err != nil {
		d.Logger.Error("register: generate token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	refresh, err := auth.GenerateRefreshToken(d.AuthCfg.JWTSecret, user.ID, d.AuthCfg.RefreshExpiry)
	if err != nil {
		d.Logger.Error("register: generate refresh token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusCreated, authResponse{
		Token:        token,
		RefreshToken: refresh,
		User:         user,
	})
}

// Login authenticates an existing user with email and password.
//
//	POST /v1/auth/login
func (d *Deps) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, "email and password are required")
		return
	}

	var user models.User
	err := d.DB.GetContext(r.Context(), &user,
		`SELECT id, email, password_hash, name, role, minutes_used, minutes_quota, created_at, updated_at
		 FROM users WHERE email = $1`, req.Email)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
		d.Logger.Error("login: query user", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if !user.PasswordHash.Valid {
		writeErr(w, http.StatusUnauthorized, "this account uses social login")
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash.String), []byte(req.Password)); err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	token, err := auth.GenerateToken(d.AuthCfg.JWTSecret, user.ID, user.Email, user.Role, d.AuthCfg.JWTExpiry)
	if err != nil {
		d.Logger.Error("login: generate token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	refresh, err := auth.GenerateRefreshToken(d.AuthCfg.JWTSecret, user.ID, d.AuthCfg.RefreshExpiry)
	if err != nil {
		d.Logger.Error("login: generate refresh token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Token:        token,
		RefreshToken: refresh,
		User:         user,
	})
}

// Refresh issues a new JWT using a valid refresh token.
//
//	POST /v1/auth/refresh
func (d *Deps) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	userID, err := parseRefreshToken(d.AuthCfg.JWTSecret, req.RefreshToken)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}

	var user models.User
	err = d.DB.GetContext(r.Context(), &user,
		`SELECT id, email, password_hash, name, role, minutes_used, minutes_quota, created_at, updated_at
		 FROM users WHERE id = $1`, userID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusUnauthorized, "user not found")
			return
		}
		d.Logger.Error("refresh: query user", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	token, err := auth.GenerateToken(d.AuthCfg.JWTSecret, user.ID, user.Email, user.Role, d.AuthCfg.JWTExpiry)
	if err != nil {
		d.Logger.Error("refresh: generate token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	newRefresh, err := auth.GenerateRefreshToken(d.AuthCfg.JWTSecret, user.ID, d.AuthCfg.RefreshExpiry)
	if err != nil {
		d.Logger.Error("refresh: generate refresh token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Token:        token,
		RefreshToken: newRefresh,
		User:         user,
	})
}

// GoogleAuth exchanges a Google OAuth authorization code for a user session.
// Creates the user if this is their first login.
//
//	POST /v1/auth/google
func (d *Deps) GoogleAuth(w http.ResponseWriter, r *http.Request) {
	var req googleAuthRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Code == "" {
		writeErr(w, http.StatusBadRequest, "authorization code is required")
		return
	}

	// Exchange code for token with Google.
	gUser, err := exchangeGoogleCode(d.AuthCfg, req.Code)
	if err != nil {
		d.Logger.Error("google auth: exchange code", "error", err)
		writeErr(w, http.StatusUnauthorized, "failed to authenticate with Google")
		return
	}

	// Look up by OAuth provider + id first.
	var user models.User
	err = d.DB.GetContext(r.Context(), &user,
		`SELECT id, email, password_hash, name, role, oauth_provider, oauth_id, avatar_url,
		        minutes_used, minutes_quota, created_at, updated_at
		 FROM users WHERE oauth_provider = 'google' AND oauth_id = $1`, gUser.ID)

	if err == sql.ErrNoRows {
		// Check if the email is already taken by a password-based account.
		err = d.DB.GetContext(r.Context(), &user,
			`SELECT id, email, password_hash, name, role, oauth_provider, oauth_id, avatar_url,
			        minutes_used, minutes_quota, created_at, updated_at
			 FROM users WHERE email = $1`, gUser.Email)
		if err == nil {
			// Link the existing account to Google.
			_, linkErr := d.DB.ExecContext(r.Context(),
				`UPDATE users SET oauth_provider = 'google', oauth_id = $1, avatar_url = $2, updated_at = $3 WHERE id = $4`,
				gUser.ID, gUser.AvatarURL, time.Now().UTC(), user.ID)
			if linkErr != nil {
				d.Logger.Error("google auth: link account", "error", linkErr)
				writeErr(w, http.StatusInternalServerError, "internal server error")
				return
			}
		} else if err == sql.ErrNoRows {
			// Brand-new user.
			user = models.User{
				ID:            uuid.New().String(),
				Email:         gUser.Email,
				Name:          gUser.Name,
				Role:          models.RoleFree,
				OAuthProvider: sql.NullString{String: "google", Valid: true},
				OAuthID:       sql.NullString{String: gUser.ID, Valid: true},
				AvatarURL:     sql.NullString{String: gUser.AvatarURL, Valid: gUser.AvatarURL != ""},
				MinutesQuota:  30,
				CreatedAt:     time.Now().UTC(),
				UpdatedAt:     time.Now().UTC(),
			}
			_, insertErr := d.DB.ExecContext(r.Context(),
				`INSERT INTO users (id, email, name, role, oauth_provider, oauth_id, avatar_url, minutes_used, minutes_quota, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
				user.ID, user.Email, user.Name, user.Role, user.OAuthProvider, user.OAuthID,
				user.AvatarURL, user.MinutesUsed, user.MinutesQuota, user.CreatedAt, user.UpdatedAt)
			if insertErr != nil {
				d.Logger.Error("google auth: insert user", "error", insertErr)
				writeErr(w, http.StatusInternalServerError, "internal server error")
				return
			}
		} else {
			d.Logger.Error("google auth: lookup by email", "error", err)
			writeErr(w, http.StatusInternalServerError, "internal server error")
			return
		}
	} else if err != nil {
		d.Logger.Error("google auth: lookup by oauth_id", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	token, err := auth.GenerateToken(d.AuthCfg.JWTSecret, user.ID, user.Email, user.Role, d.AuthCfg.JWTExpiry)
	if err != nil {
		d.Logger.Error("google auth: generate token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	refresh, err := auth.GenerateRefreshToken(d.AuthCfg.JWTSecret, user.ID, d.AuthCfg.RefreshExpiry)
	if err != nil {
		d.Logger.Error("google auth: generate refresh token", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Token:        token,
		RefreshToken: refresh,
		User:         user,
	})
}

// Me returns the currently authenticated user.
//
//	GET /v1/auth/me
func (d *Deps) Me(w http.ResponseWriter, r *http.Request) {
	claims := mw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var user models.User
	err := d.DB.GetContext(r.Context(), &user,
		`SELECT id, email, name, role, avatar_url, minutes_used, minutes_quota, created_at, updated_at
		 FROM users WHERE id = $1`, claims.UserID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		d.Logger.Error("me: query user", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, user)
}

// ---------- internal helpers ----------

// googleUserInfo represents the subset of Google's userinfo response we need.
type googleUserInfo struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	AvatarURL string `json:"picture"`
}

// exchangeGoogleCode exchanges an authorization code for user profile info.
func exchangeGoogleCode(cfg config.Auth, code string) (*googleUserInfo, error) {
	body := "code=" + code +
		"&client_id=" + cfg.GoogleClientID +
		"&client_secret=" + cfg.GoogleSecret +
		"&redirect_uri=postmessage" +
		"&grant_type=authorization_code"

	resp, err := http.Post("https://oauth2.googleapis.com/token",
		"application/x-www-form-urlencoded", strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodGet, "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tokenResp.AccessToken)

	uiResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer uiResp.Body.Close()

	var gUser googleUserInfo
	if err := json.NewDecoder(uiResp.Body).Decode(&gUser); err != nil {
		return nil, err
	}
	return &gUser, nil
}

// parseRefreshToken validates a refresh token and returns the embedded user ID
// (stored as the JWT Subject). Refresh tokens use RegisteredClaims only (no
// custom fields) and have Issuer "recast-ai-refresh".
func parseRefreshToken(secret, tokenStr string) (string, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &jwt.RegisteredClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, auth.ErrInvalidToken
		}
		return []byte(secret), nil
	})
	if err != nil {
		return "", auth.ErrInvalidToken
	}

	claims, ok := token.Claims.(*jwt.RegisteredClaims)
	if !ok || !token.Valid {
		return "", auth.ErrInvalidToken
	}

	if claims.Issuer != "recast-ai-refresh" || claims.Subject == "" {
		return "", auth.ErrInvalidToken
	}

	return claims.Subject, nil
}

// ---------- shared JSON helpers ----------

func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
