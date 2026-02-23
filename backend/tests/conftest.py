"""
Shared pytest fixtures for integration tests.

pytest-asyncio (asyncio_mode=auto) gives each test its own event loop.
The module-level engine in app.database is bound to the event loop of
the first import, so sharing it across tests fails with asyncpg's
"another operation is in progress" error.

Fix: each `db` fixture creates a new SQLAlchemy engine (and therefore a
new asyncpg connection pool) bound to the current test's event loop, then
disposes it at teardown. The overhead is acceptable for integration tests.

Each test creates data under a unique project UUID; no cleanup needed
because queries are always project-scoped and test rows are harmless.
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings


@pytest.fixture
async def db():
    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()
