"""Configuration for the TTS Service.

Loads settings from environment variables with sensible defaults for local
development.  Uses pydantic-settings so every value can be overridden via
an env var or a .env file placed next to this module.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """TTS Service configuration."""

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
        default="", description="Full AMQP(S) URL that overrides individual fields"
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

    # --- TTS providers ---
    tts_provider: str = Field(
        default="gtts",
        description="TTS provider: elevenlabs, polly, or gtts",
    )
    elevenlabs_api_key: str = Field(default="", description="ElevenLabs API key (optional)")
    elevenlabs_model_id: str = Field(
        default="eleven_multilingual_v2",
        description="ElevenLabs model identifier",
    )

    # AWS Polly credentials (all optional)
    aws_access_key_id: str = Field(default="", description="AWS access key id")
    aws_secret_access_key: str = Field(default="", description="AWS secret access key")
    aws_region: str = Field(default="us-east-1", description="AWS region for Polly")
    polly_engine: str = Field(
        default="neural", description="Polly engine: standard or neural"
    )

    # --- Logging ---
    log_level: str = Field(default="INFO", description="Log level (DEBUG, INFO, WARNING, ERROR)")

    # --- Database ---
    db_sslmode: str = Field(default="disable", description="PostgreSQL sslmode")

    # --- Derived helpers ---

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

    @property
    def is_dev_mode(self) -> bool:
        """True when the selected provider lacks credentials."""
        if self.tts_provider == "elevenlabs":
            return not self.elevenlabs_api_key
        if self.tts_provider == "polly":
            return not (self.aws_access_key_id and self.aws_secret_access_key)
        return False


settings = Settings()
