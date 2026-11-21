"""Shared fixtures for the generated API tests."""

import asyncio
import os

import pytest
from api.routers.api.internal.health import draining
from env.telemetry import env as telemetry_env
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.hooks import FastAPIHooks

telemetry_env.telemetry_enabled = False


def build_app(
    *,
    hooks: FastAPIHooks | None = None,
    routers: str = "api.routers",
    prefix: str = "",
) -> FastAPI:
    # Importing api.main constructs its module-level app, so do it only after telemetry is disabled.
    from api.main import create_app

    app = create_app(hooks=hooks if hooks is not None else FastAPIHooks.empty())
    if routers != "api.routers" or prefix:
        from mistralai_capabilities.fastapi.routing import create_api_router

        app.router.routes.clear()
        app.include_router(create_api_router(routers, prefix=prefix))
    app.dependency_overrides[draining] = lambda: False
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_app())


# --- Ghost milestone-2 test database -------------------------------------------------
#
# The ghost routes persist through the app's own engine (`db.get_session_maker`), so tests point
# `env.db.env.database_url` at a scratch database before the engine is first created:
#
# - `GHOST_TEST_DATABASE_URL` set        -> used verbatim (e.g. a live Postgres);
# - `RUN_PG_CONTRACT=1`                  -> a throwaway real PostgreSQL via `pgserver`
#   (SELECT ... FOR UPDATE semantics included; needs a Python with pgserver wheels, e.g. 3.12);
# - otherwise                            -> a scratch SQLite file (aiosqlite), where FOR UPDATE
#   renders as a no-op and writers are serialized by SQLite itself.
#
# The engine pool is swapped for NullPool so connections are never reused across the different
# event loops of TestClient requests and direct asyncio calls in a test.


@pytest.fixture(scope="session")
def ghost_database_url(tmp_path_factory) -> str:
    override = os.getenv("GHOST_TEST_DATABASE_URL")
    if override:
        return override
    if os.getenv("RUN_PG_CONTRACT"):
        import pgserver

        server = pgserver.get_server(str(tmp_path_factory.mktemp("pgserver")))
        return server.get_uri().replace("postgresql://", "postgresql+asyncpg://", 1)
    path = tmp_path_factory.mktemp("sqlite") / "ghost-test.db"
    return f"sqlite+aiosqlite:///{path}"


@pytest.fixture(scope="session")
def database(ghost_database_url: str) -> str:
    import env.db as env_db
    from db import engine as db_engine
    from db import metadata
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    original_url = env_db.env.database_url
    original_factory = db_engine.create_async_engine

    def nullpool_factory(url, **kwargs):
        kwargs["poolclass"] = NullPool
        kwargs.pop("pool_size", None)
        kwargs.pop("max_overflow", None)
        return original_factory(url, **kwargs)

    env_db.env.database_url = ghost_database_url
    db_engine._engine = None
    db_engine._session_maker = None
    db_engine._readiness_engine = None
    db_engine.create_async_engine = nullpool_factory

    async def _create() -> None:
        engine = create_async_engine(ghost_database_url, poolclass=NullPool)
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        await engine.dispose()

    asyncio.run(_create())
    yield ghost_database_url
    asyncio.run(db_engine.dispose_engine())
    env_db.env.database_url = original_url
    db_engine.create_async_engine = original_factory


@pytest.fixture
def db(database: str) -> str:
    """Function-scoped: a clean ghost schema (all rows removed) on the scratch database."""
    import env.db as env_db
    from db import metadata
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    async def _clear() -> None:
        engine = create_async_engine(env_db.env.async_database_url, poolclass=NullPool)
        async with engine.begin() as connection:
            for table in ("ghost_artifact", "ghost_erasure", "ghost_namespace", "ghost_session"):
                await connection.execute(text(f"DELETE FROM {table}"))
        await engine.dispose()

    asyncio.run(_clear())
    return database
