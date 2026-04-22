package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/redis/go-redis/v9"

	"github.com/officialasishkumar/recast-ai/internal/gateway/handler"
	mw "github.com/officialasishkumar/recast-ai/internal/gateway/middleware"
	ws "github.com/officialasishkumar/recast-ai/internal/gateway/websocket"
	"github.com/officialasishkumar/recast-ai/pkg/config"
	"github.com/officialasishkumar/recast-ai/pkg/database"
	"github.com/officialasishkumar/recast-ai/pkg/queue"
	"github.com/officialasishkumar/recast-ai/pkg/storage"
)

func main() {
	// ---- configuration ----
	base := config.LoadBase("api-gateway")
	dbCfg := config.LoadDatabase()
	redisCfg := config.LoadRedis()
	rabbitCfg := config.LoadRabbitMQ()
	storageCfg := config.LoadStorage()
	authCfg := config.LoadAuth()

	// ---- logger ----
	var level slog.Level
	switch base.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)
	logger.Info("starting api-gateway", "env", base.Environment)

	// ---- database ----
	db, err := database.Connect(dbCfg, logger)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// ---- redis ----
	rdb := redis.NewClient(&redis.Options{
		Addr:      redisCfg.Addr(),
		Password:  redisCfg.Password,
		DB:        redisCfg.DB,
		TLSConfig: redisCfg.TLSConfig(),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := rdb.Ping(ctx).Err(); err != nil {
		logger.Error("failed to connect to redis", "error", err)
		os.Exit(1)
	}
	cancel()
	defer rdb.Close()
	logger.Info("redis connected", "addr", redisCfg.Addr())

	// ---- rabbitmq ----
	qConn, err := queue.Connect(rabbitCfg.URL(), logger)
	if err != nil {
		logger.Error("failed to connect to rabbitmq", "error", err)
		os.Exit(1)
	}
	defer qConn.Close()

	// Declare the queues this gateway publishes to.
	for _, q := range []string{queue.IngestionQueue, queue.TranscriptQueue} {
		if err := qConn.DeclareQueue(q); err != nil {
			logger.Error("failed to declare queue", "queue", q, "error", err)
			os.Exit(1)
		}
	}

	// ---- storage (MinIO / S3) ----
	store, err := storage.New(storageCfg, logger)
	if err != nil {
		logger.Error("failed to connect to storage", "error", err)
		os.Exit(1)
	}

	// ---- websocket hub ----
	hub := ws.NewHub(rdb, logger)

	// ---- handler dependencies ----
	deps := &handler.Deps{
		DB:      db,
		Store:   store,
		Queue:   qConn,
		Redis:   rdb,
		AuthCfg: authCfg,
		Logger:  logger,
	}

	// ---- router ----
	r := chi.NewRouter()

	// Global middleware chain.
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Request-ID"},
		ExposedHeaders:   []string{"X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check (unauthenticated).
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	})

	r.Route("/v1", func(v1 chi.Router) {
		// ---------- public auth routes ----------
		v1.Route("/auth", func(auth chi.Router) {
			auth.Post("/register", deps.Register)
			auth.Post("/login", deps.Login)
			auth.Post("/refresh", deps.Refresh)
			auth.Post("/google", deps.GoogleAuth)

			// /auth/me requires authentication.
			auth.With(mw.JWTAuth(authCfg)).Get("/me", deps.Me)
		})

		// ---------- public share routes (no auth) ----------
		v1.Get("/public/shares/{token}", deps.PublicShare)

		// ---------- authenticated routes ----------
		v1.Group(func(authed chi.Router) {
			authed.Use(mw.JWTAuth(authCfg))
			authed.Use(mw.RateLimiter(rdb, mw.DefaultLimit(), logger))

			// Jobs.
			authed.Post("/jobs", deps.CreateJob)
			authed.Get("/jobs", deps.ListJobs)
			authed.Get("/jobs/{id}", deps.GetJob)
			authed.Delete("/jobs/{id}", deps.DeleteJob)

			// Transcript.
			authed.Get("/jobs/{id}/transcript", deps.GetTranscript)
			authed.Patch("/jobs/{id}/transcript", deps.UpdateTranscript)

			// Segment regeneration.
			authed.Post("/jobs/{id}/segments/{segmentId}/regenerate", deps.RegenerateSegment)

			// Share links.
			authed.Post("/jobs/{id}/share", deps.CreateShare)
			authed.Delete("/jobs/{id}/share", deps.DeleteShare)

			// Export.
			authed.Get("/jobs/{id}/export", deps.ExportJob)

			// Voices.
			authed.Get("/voices", deps.ListVoices)
		})

		// ---------- websocket (token validated at app level) ----------
		v1.Get("/ws/jobs/{id}", hub.HandleWS)
	})

	// ---- HTTP server ----
	port := config.Env("PORT", "8080")
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in background.
	go func() {
		logger.Info("http server listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server error", "error", err)
			os.Exit(1)
		}
	}()

	// ---- graceful shutdown ----
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	logger.Info("shutdown signal received", "signal", sig.String())

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutCancel()

	hub.Shutdown()

	if err := srv.Shutdown(shutCtx); err != nil {
		logger.Error("http server shutdown error", "error", err)
	}

	logger.Info("api-gateway stopped")
}
