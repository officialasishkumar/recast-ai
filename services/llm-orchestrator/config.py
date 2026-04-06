"""Configuration for the LLM Orchestrator service.

Loads settings from environment variables with sensible defaults for local
development.  Uses pydantic-settings so every value can be overridden via
an env var or a .env file placed next to this module.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """LLM Orchestrator configuration."""

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

    # --- Anthropic ---
    anthropic_api_key: str = Field(default="", description="Anthropic API key")
    llm_model: str = Field(
        default="claude-sonnet-4-20250514",
        description="Claude model identifier",
    )

    # --- Logging ---
    log_level: str = Field(default="INFO", description="Log level (DEBUG, INFO, WARNING, ERROR)")

    # --- Derived helpers (not loaded from env) ---

    @property
    def rabbitmq_url(self) -> str:
        return (
            f"amqp://{self.rabbitmq_user}:{self.rabbitmq_password}"
            f"@{self.rabbitmq_host}:{self.rabbitmq_port}/"
        )

    @property
    def dsn(self) -> str:
        return (
            f"host={self.db_host} port={self.db_port} user={self.db_user} "
            f"password={self.db_password} dbname={self.db_name} sslmode=disable"
        )

    @property
    def db_url(self) -> str:
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


settings = Settings()
