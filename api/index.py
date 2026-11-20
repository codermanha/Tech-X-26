"""Vercel Python Serverless Entrypoint exporting an explicit top-level FastAPI `app`."""
from src.api.main import create_app

app = create_app()
