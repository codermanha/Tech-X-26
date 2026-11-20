"""ClearTurn FastAPI Application Factory & Centralized Exception Handling.

Run directly via:
    python backend.py
or:
    python -m uvicorn src.api.main:app --reload --port 8000

Interactive OpenAPI / Swagger documentation is available at:
    http://localhost:8000/docs
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from src.api.dependencies import ensure_database_seeded
from src.api.routes import advanced, chat, curveballs, milestones, orchestrator, patients, stretch, system
from src.core.dag_engine import (
    AuthorityBoundaryError,
    DAGDependencyViolationError,
    OptimisticLockConflictError,
    RBACViolationError,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("clearturn.api")

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8501",
    "http://127.0.0.1:8501",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting ClearTurn FastAPI backend; verifying SQLite WAL database...")
    ensure_database_seeded()
    logger.info("Database verified and ready.")
    yield
    logger.info("Shutting down ClearTurn FastAPI backend.")


def _error_payload(error_code: str, message: str, details: dict | None = None) -> dict:
    return {
        "error_code": error_code,
        "message": message,
        "detail": message,
        "details": details,
    }


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(DAGDependencyViolationError)
    async def handle_dag_violation(request: Request, exc: DAGDependencyViolationError):
        logger.warning("DAGDependencyViolationError on %s: %s", request.url.path, exc)
        return JSONResponse(
            status_code=422,
            content=_error_payload("DAGDependencyViolationError", str(exc)),
        )

    @app.exception_handler(OptimisticLockConflictError)
    async def handle_occ_conflict(request: Request, exc: OptimisticLockConflictError):
        logger.warning("OptimisticLockConflictError on %s: %s", request.url.path, exc)
        return JSONResponse(
            status_code=409,
            content=_error_payload("OptimisticLockConflictError", str(exc)),
        )

    @app.exception_handler(AuthorityBoundaryError)
    async def handle_authority_error(request: Request, exc: AuthorityBoundaryError):
        logger.warning("AuthorityBoundaryError on %s: %s", request.url.path, exc)
        return JSONResponse(
            status_code=403,
            content=_error_payload("AuthorityBoundaryError", str(exc)),
        )

    @app.exception_handler(RBACViolationError)
    async def handle_rbac_error(request: Request, exc: RBACViolationError):
        logger.warning("RBACViolationError on %s: %s", request.url.path, exc)
        return JSONResponse(
            status_code=403,
            content=_error_payload("RBACViolationError", str(exc)),
        )

    @app.exception_handler(LookupError)
    async def handle_lookup_error(request: Request, exc: LookupError):
        logger.warning("Resource not found on %s: %s", request.url.path, exc)
        return JSONResponse(
            status_code=404,
            content=_error_payload("NotFoundError", str(exc)),
        )

    @app.exception_handler(HTTPException)
    async def handle_http_exception(request: Request, exc: HTTPException):
        code_map = {
            400: "BadRequestError",
            403: "RBACViolationError",
            404: "NotFoundError",
            409: "OptimisticLockConflictError",
            422: "ValidationError",
        }
        error_code = code_map.get(exc.status_code, f"HTTP_{exc.status_code}")
        msg = str(exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(error_code, msg),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        msg = "Request payload validation failed."
        return JSONResponse(
            status_code=422,
            content=_error_payload("RequestValidationError", msg, {"errors": exc.errors()}),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception):
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=_error_payload(
                "InternalServerError",
                "An unexpected server error occurred. Please check backend logs.",
            ),
        )


def create_app() -> FastAPI:
    app = FastAPI(
        title="ClearTurn — Autonomous Hospital Discharge Orchestration API",
        description=(
            "Modular REST backend enforcing DAG topological order, SQLite WAL optimistic "
            "concurrency locking, deterministic RBAC PHI stripping, and LLM-drafted specialist escalations."
        ),
        version="2.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|.*\.(devtunnels\.ms|github\.dev))(:\d+)?$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    # Register modular route controllers
    app.include_router(system.router)
    app.include_router(patients.router)
    app.include_router(milestones.router)
    app.include_router(orchestrator.router)
    app.include_router(stretch.router)
    app.include_router(advanced.router)
    app.include_router(curveballs.router)
    app.include_router(chat.router)

    dist_dir = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    assets_dir = dist_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/", include_in_schema=False)
    def serve_frontend_root():
        index_file = dist_dir / "index.html"
        if index_file.is_file():
            return FileResponse(str(index_file))
        return {"service": "ClearTurn API", "docs": "/docs"}

    return app


app = create_app()
