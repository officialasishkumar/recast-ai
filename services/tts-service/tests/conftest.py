"""Pytest configuration for tts-service tests.

Ensures the service root is importable as a package root so tests can do
``from tts.alignment import ...`` without installing the project.
"""

from __future__ import annotations

import os
import sys

_SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)
