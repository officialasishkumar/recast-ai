"""Shared observability helpers for Recast AI Python services.

Provides Prometheus metrics, an OpenTelemetry tracer, and a lightweight
metrics HTTP server suitable for sidecar exposition.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import structlog
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    Counter,
    Histogram,
    generate_latest,
)

try:
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
except Exception:  # pragma: no cover - tracing is optional at runtime
    trace = None  # type: ignore[assignment]
    OTLPSpanExporter = None  # type: ignore[assignment]
    Resource = None  # type: ignore[assignment]
    TracerProvider = None  # type: ignore[assignment]
    BatchSpanProcessor = None  # type: ignore[assignment]


_log = structlog.get_logger("observability")

# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #

JOBS_PROCESSED = Counter(
    "jobs_processed_total",
    "Number of jobs processed by this service.",
    ["service", "outcome"],
)

JOB_DURATION = Histogram(
    "job_processing_seconds",
    "Time spent processing a single job.",
    ["service"],
    buckets=(0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600),
)

QUEUE_MESSAGES = Counter(
    "queue_messages_total",
    "Number of queue messages handled.",
    ["service", "queue", "outcome"],
)


# --------------------------------------------------------------------------- #
# Metrics HTTP server
# --------------------------------------------------------------------------- #


def start_metrics_server(port: int) -> None:
    """Start a tiny HTTP server that serves /metrics and /healthz."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
            if self.path == "/metrics":
                payload = generate_latest(REGISTRY)
                self.send_response(200)
                self.send_header("Content-Type", CONTENT_TYPE_LATEST)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            elif self.path in ("/healthz", "/readyz"):
                body = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return  # silence default access logs

    def serve() -> None:
        try:
            server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
            server.serve_forever()
        except OSError as exc:
            _log.warning("metrics_server_start_failed", error=str(exc))

    thread = threading.Thread(target=serve, daemon=True, name="metrics-server")
    thread.start()
    _log.info("metrics_server_started", port=port)


# --------------------------------------------------------------------------- #
# Tracing
# --------------------------------------------------------------------------- #


def init_tracing(service_name: str) -> Any:
    """Initialize an OpenTelemetry tracer and export over OTLP gRPC.

    Returns the tracer or ``None`` if OpenTelemetry is unavailable or no
    endpoint is configured. Endpoint is read from
    ``OTEL_EXPORTER_OTLP_ENDPOINT``.
    """
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint or trace is None:
        return None

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _log.info("tracing_started", endpoint=endpoint, service=service_name)
    return trace.get_tracer(service_name)


# --------------------------------------------------------------------------- #
# Public helpers used by services
# --------------------------------------------------------------------------- #


def setup_observability(service_name: str, default_port: int = 9100) -> Any:
    """Bootstrap metrics and tracing for a service in one call."""
    port = int(os.environ.get("METRICS_PORT", str(default_port)))
    start_metrics_server(port)
    return init_tracing(service_name)
