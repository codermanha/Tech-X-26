"""System health, metadata config, and demo state reset endpoints."""
import logging
from fastapi import APIRouter

from src.api.dependencies import ROLE_BANNERS, ROLE_LABELS, ensure_database_seeded
from src.api.schemas import HealthResponse, SystemConfigResponse, SystemResetResponse
from src.config import (
    AI_ALLOWED_MILESTONES,
    DAG_DEPENDENCIES,
    LLM_PROVIDER,
    MILESTONE_ORDER,
    MILESTONE_ROLE_PERMISSIONS,
    PHI_STRIPPED_ROLES,
    get_db_path,
)
from src.database.seed import seed_database
from src.stretch.multilingual_summary import SUPPORTED_LANGUAGES

logger = logging.getLogger("clearturn.api.system")
router = APIRouter(prefix="/api", tags=["System & Config"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Backend health & SQLite WAL status check",
)
def health_check() -> HealthResponse:
    """Verify the FastAPI service and SQLite WAL database are online."""
    ensure_database_seeded()
    return HealthResponse(
        status="ok",
        service="ClearTurn Discharge Orchestration Backend",
        database=get_db_path().name,
        llm_provider=LLM_PROVIDER,
    )


@router.get(
    "/config",
    response_model=SystemConfigResponse,
    summary="Get DAG topology, RBAC role metadata, and system constants",
)
def get_system_config() -> SystemConfigResponse:
    """Return DAG topology, role metadata, permissions, and supported languages."""
    return SystemConfigResponse(
        roles=[
            {
                "id": role_id,
                "label": label,
                "banner": ROLE_BANNERS[role_id],
                "phi_stripped": role_id in PHI_STRIPPED_ROLES,
            }
            for role_id, label in ROLE_LABELS.items()
        ],
        milestone_order=MILESTONE_ORDER,
        dag_dependencies=DAG_DEPENDENCIES,
        milestone_role_permissions={
            k: sorted(list(v)) for k, v in MILESTONE_ROLE_PERMISSIONS.items()
        },
        ai_allowed_milestones=sorted(list(AI_ALLOWED_MILESTONES)),
        phi_stripped_roles=sorted(list(PHI_STRIPPED_ROLES)),
        supported_languages=SUPPORTED_LANGUAGES,
        database_file=get_db_path().name,
    )


@router.post(
    "/system/reset",
    response_model=SystemResetResponse,
    summary="Reset and re-seed the SQLite WAL demo database",
)
def reset_demo_state() -> SystemResetResponse:
    """Reset and re-seed the SQLite WAL database to the clean v1 demo state."""
    count = seed_database(reset=True)
    logger.info("Database reset and re-seeded with %d inpatient cases.", count)
    return SystemResetResponse(
        success=True,
        patients_seeded=count,
        message=f"Database reset and re-seeded with {count} inpatient cases.",
    )
