"""Vercel Python Serverless Entrypoint exporting the top-level FastAPI `app`."""
from src.api.main import app  # noqa: F401
