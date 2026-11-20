"""Vercel Python Serverless Entrypoint exporting the FastAPI `app`."""
import sys
import traceback
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from src.api.main import app  # noqa: E402, F401
except Exception as exc:  # pragma: no cover
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    _tb = traceback.format_exc()
    _err = f"{type(exc).__name__}: {exc}"
    app = FastAPI()

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def _startup_error(full_path: str = ""):
        return JSONResponse(status_code=500, content={"error": _err, "traceback": _tb})
