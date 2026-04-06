package database

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/officialasishkumar/recast-ai/pkg/config"
)

// Connect opens a PostgreSQL connection pool with retry.
func Connect(cfg config.Database, logger *slog.Logger) (*sqlx.DB, error) {
	var db *sqlx.DB
	var err error

	for i := 0; i < 30; i++ {
		db, err = sqlx.Connect("postgres", cfg.DSN())
		if err == nil {
			break
		}
		logger.Warn("postgres not ready, retrying", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("connect to postgres after retries: %w", err)
	}

	db.SetMaxOpenConns(cfg.MaxConns)
	db.SetMaxIdleConns(cfg.MaxConns / 2)
	db.SetConnMaxLifetime(30 * time.Minute)

	logger.Info("database connected", "host", cfg.Host, "db", cfg.Name)
	return db, nil
}
