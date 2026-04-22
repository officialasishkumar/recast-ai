package config

import (
	"crypto/tls"
	"fmt"
	"os"
	"strconv"
	"time"
)

// Base holds configuration common to all services.
type Base struct {
	ServiceName     string
	Environment     string // development, staging, production
	LogLevel        string
	RateLimitPerMin int
	OTELEndpoint    string
}

// Database holds PostgreSQL connection settings.
type Database struct {
	Host     string
	Port     int
	User     string
	Password string
	Name     string
	SSLMode  string
	MaxConns int
}

// DSN returns a libpq-compatible connection string.
func (d Database) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode,
	)
}

// Redis holds Redis connection settings.
type Redis struct {
	Host     string
	Port     int
	Password string
	DB       int
	UseTLS   bool
}

// Addr returns the host:port pair for the Redis client.
func (r Redis) Addr() string {
	return fmt.Sprintf("%s:%d", r.Host, r.Port)
}

// TLSConfig returns a *tls.Config when TLS is enabled, nil otherwise.
func (r Redis) TLSConfig() *tls.Config {
	if r.UseTLS {
		return &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return nil
}

// RabbitMQ holds AMQP connection settings.
type RabbitMQ struct {
	Host     string
	Port     int
	User     string
	Password string
	VHost    string
	RawURL   string // full AMQP(S) URL — if set, overrides individual fields
}

// URL returns the AMQP connection string.
func (r RabbitMQ) URL() string {
	if r.RawURL != "" {
		return r.RawURL
	}
	return fmt.Sprintf("amqp://%s:%s@%s:%d/%s", r.User, r.Password, r.Host, r.Port, r.VHost)
}

// Storage holds S3/MinIO connection settings.
type Storage struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	Region    string
	UseSSL    bool
}

// Auth holds JWT and OAuth settings.
type Auth struct {
	JWTSecret      string
	JWTExpiry      time.Duration
	RefreshExpiry  time.Duration
	GoogleClientID string
	GoogleSecret   string
	GitHubClientID string
	GitHubSecret   string
}

// Gemini holds Google Gemini API settings used by Go callers (if any).
type Gemini struct {
	APIKey        string
	Model         string
	FallbackModel string
}

// Env reads an environment variable with a default fallback.
func Env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// EnvInt reads an integer environment variable with a default fallback.
func EnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return fallback
}

// EnvBool reads a boolean environment variable with a default fallback.
func EnvBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return fallback
}

// EnvDuration reads a duration environment variable with a default fallback.
func EnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return fallback
}

// LoadBase loads the common configuration from environment variables.
func LoadBase(serviceName string) Base {
	return Base{
		ServiceName:     serviceName,
		Environment:     Env("ENVIRONMENT", "development"),
		LogLevel:        Env("LOG_LEVEL", "info"),
		RateLimitPerMin: EnvInt("RATE_LIMIT_PER_MIN", 60),
		OTELEndpoint:    Env("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
	}
}

// LoadDatabase loads PostgreSQL config from environment variables.
func LoadDatabase() Database {
	return Database{
		Host:     Env("DB_HOST", "localhost"),
		Port:     EnvInt("DB_PORT", 5432),
		User:     Env("DB_USER", "recast"),
		Password: Env("DB_PASSWORD", "recast"),
		Name:     Env("DB_NAME", "recast"),
		SSLMode:  Env("DB_SSLMODE", "disable"),
		MaxConns: EnvInt("DB_MAX_CONNS", 20),
	}
}

// LoadRedis loads Redis config from environment variables.
func LoadRedis() Redis {
	return Redis{
		Host:     Env("REDIS_HOST", "localhost"),
		Port:     EnvInt("REDIS_PORT", 6379),
		Password: Env("REDIS_PASSWORD", ""),
		DB:       EnvInt("REDIS_DB", 0),
		UseTLS:   EnvBool("REDIS_TLS", false),
	}
}

// LoadRabbitMQ loads AMQP config from environment variables.
func LoadRabbitMQ() RabbitMQ {
	return RabbitMQ{
		Host:     Env("RABBITMQ_HOST", "localhost"),
		Port:     EnvInt("RABBITMQ_PORT", 5672),
		User:     Env("RABBITMQ_USER", "guest"),
		Password: Env("RABBITMQ_PASSWORD", "guest"),
		VHost:    Env("RABBITMQ_VHOST", ""),
		RawURL:   Env("RABBITMQ_URL", ""),
	}
}

// LoadStorage loads S3/MinIO config from environment variables.
func LoadStorage() Storage {
	return Storage{
		Endpoint:  Env("S3_ENDPOINT", "localhost:9000"),
		AccessKey: Env("S3_ACCESS_KEY", "minioadmin"),
		SecretKey: Env("S3_SECRET_KEY", "minioadmin"),
		Bucket:    Env("S3_BUCKET", "recast"),
		Region:    Env("S3_REGION", "us-east-1"),
		UseSSL:    EnvBool("S3_USE_SSL", false),
	}
}

// LoadAuth loads authentication config from environment variables.
func LoadAuth() Auth {
	return Auth{
		JWTSecret:      Env("JWT_SECRET", "dev-secret-change-in-production"),
		JWTExpiry:      EnvDuration("JWT_EXPIRY", 15*time.Minute),
		RefreshExpiry:  EnvDuration("REFRESH_EXPIRY", 7*24*time.Hour),
		GoogleClientID: Env("GOOGLE_CLIENT_ID", ""),
		GoogleSecret:   Env("GOOGLE_CLIENT_SECRET", ""),
		GitHubClientID: Env("GITHUB_CLIENT_ID", ""),
		GitHubSecret:   Env("GITHUB_CLIENT_SECRET", ""),
	}
}

// LoadGemini loads Google Gemini config from environment variables.
func LoadGemini() Gemini {
	return Gemini{
		APIKey:        Env("GEMINI_API_KEY", ""),
		Model:         Env("GEMINI_MODEL", "gemini-2.5-pro"),
		FallbackModel: Env("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash"),
	}
}
