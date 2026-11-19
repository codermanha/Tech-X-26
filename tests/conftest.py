import pytest

from src.database.seed import seed_database


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.sqlite"))
    seed_database(reset=True)
    yield
