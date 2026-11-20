"""Vercel Serverless Function entrypoint for the ClearTurn FastAPI backend."""
import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src.api.main import app  # noqa: E402
