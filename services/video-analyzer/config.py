"""Configuration for the Video Analyzer service.

Loads settings from environment variables with sensible defaults for
local development. Uses pydantic-settings so every value can be
overridden via an env var or a .env file placed next to this module.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Video Analyzer configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # --- RabbitMQ ---
    rabbitmq_host: str = Field(default="localhost", description="RabbitMQ hostname")
    rabbitmq_port: int = Field(default=5672, description="RabbitMQ AMQP port")
    rabbitmq_user: str = Field(default="guest", description="RabbitMQ username")
    rabbitmq_password: str = Field(default="guest", description="RabbitMQ password")
    rabbitmq_url_override: str = Field(
        default="",
        description="Full AMQP(S) URL, overrides individual fields",
    )

    # --- S3 / MinIO ---
    s3_endpoint: str = Field(default="localhost:9000", description="S3-compatible endpoint")
    s3_access_key: str = Field(default="minioadmin", description="S3 access key")
    s3_secret_key: str = Field(default="minioadmin", description="S3 secret key")
    s3_bucket: str = Field(default="recastai", description="S3 bucket name")

    # --- Redis ---
    redis_host: str = Field(default="localhost", description="Redis hostname")
    redis_port: int = Field(default=6379, description="Redis port")

    # --- PostgreSQL ---
    db_host: str = Field(default="localhost", description="PostgreSQL hostname")
    db_port: int = Field(default=5432, description="PostgreSQL port")
    db_user: str = Field(default="recast", description="PostgreSQL user")
    db_password: str = Field(default="recast", description="PostgreSQL password")
    db_name: str = Field(default="recastai", description="PostgreSQL database name")
    db_sslmode: str = Field(default="disable", description="PostgreSQL sslmode")

    # --- Gemini ---
    gemini_api_key: str = Field(default="", description="Google Gemini API key")
    gemini_model: str = Field(
        default="gemini-2.5-pro",
        description="Primary Gemini model identifier",
    )
    gemini_fallback_model: str = Field(
        default="gemini-2.5-flash",
        description="Fallback Gemini model for long videos",
    )
    gemini_timeout_s: int = Field(
        default=600,
        description="Timeout in seconds for Gemini generate_content calls",
    )

    # --- Temp / working storage ---
    tmp_dir: str = Field(
        default="/tmp/video-analyzer",
        description="Temp directory for downloaded videos (prefer tmpfs)",
    )

    # --- Health server port ---
    health_port: int = Field(default=8080, description="FastAPI health-check port")

    # --- Logging ---
    log_level: str = Field(default="INFO", description="Log level (DEBUG, INFO, WARNING, ERROR)")

    # --- Derived helpers (not loaded from env) ---

    @property
    def rabbitmq_url(self) -> str:
        if self.rabbitmq_url_override:
            return self.rabbitmq_url_override
        return (
            f"amqp://{self.rabbitmq_user}:{self.rabbitmq_password}"
            f"@{self.rabbitmq_host}:{self.rabbitmq_port}/"
        )

    @property
    def dsn(self) -> str:
        return (
            f"host={self.db_host} port={self.db_port} user={self.db_user} "
            f"password={self.db_password} dbname={self.db_name} sslmode={self.db_sslmode}"
        )

    @property
    def db_url(self) -> str:
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}?sslmode={self.db_sslmode}"
        )


settings = Settings()
