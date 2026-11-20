"""Vercel Python Serverless Entrypoint exporting the FastAPI `app`."""
import json
import sys
import traceback
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from src.api.main import app  # noqa: E402, F401
except Exception as exc:  # pragma: no cover - surface startup errors cleanly on Vercel
    _tb = traceback.format_exc()
    _err = f"{type(exc).__name__}: {exc}"

    async def app(scope, receive, send):
        body = json.dumps({"error": _err, "traceback": _tb}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 500,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})
