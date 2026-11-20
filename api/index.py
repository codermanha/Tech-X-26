"""Vercel Python Serverless Entrypoint exporting an explicit top-level FastAPI `app`."""
import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src.api.main import create_app  # noqa: E402

app = create_app()
