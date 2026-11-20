"""ClearTurn FastAPI Application Factory.

Run directly via:
    python backend.py
or:
    python -m uvicorn src.api.main:app --reload --port 8000

Interactive OpenAPI / Swagger documentation is available at:
    http://localhost:8000/docs
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.api.dependencies import ensure_database_seeded
from src.api.routes import advanced, milestones, orchestrator, patients, stretch, system


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_database_seeded()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="ClearTurn — Autonomous Hospital Discharge Orchestration API",
        description=(
            "Modular REST backend enforcing DAG topological order, SQLite WAL optimistic "
            "concurrency locking, deterministic RBAC PHI stripping, and LLM-drafted specialist escalations."
        ),
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register modular route controllers
    app.include_router(system.router)
    app.include_router(patients.router)
    app.include_router(milestones.router)
    app.include_router(orchestrator.router)
    app.include_router(stretch.router)
    app.include_router(advanced.router)

    return app


app = create_app()
