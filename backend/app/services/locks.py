"""PostgreSQL advisory lock helpers for project-level concurrency control.

Advisory locks are session-level: they survive COMMIT/ROLLBACK inside the
critical section and are released when the connection is closed or explicitly
unlocked.  We hold them on a *dedicated* AsyncConnection (not a pooled
session) so the lock lifetime is exactly the critical section.

Usage pattern
-------------
    async with engine.connect() as lock_conn:
        acquired = await try_acquire_project_lock(lock_conn, project_id)
        if not acquired:
            raise ProjectLockedError(...)
        try:
            # ... entire critical section using a separate AsyncSession ...
        finally:
            await release_project_lock(lock_conn, project_id)
"""
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


def derive_project_lock_key(project_id: uuid.UUID) -> int:
    """Return a stable int64 lock key for the given project UUID.

    Uses the lower 63 bits of the UUID integer representation so the result
    is always positive and fits in a PostgreSQL int8 / bigint.
    """
    return project_id.int & 0x7FFFFFFFFFFFFFFF


async def try_acquire_project_lock(
    conn: AsyncConnection, project_id: uuid.UUID
) -> bool:
    """Attempt to acquire a session-level advisory lock; return True if acquired.

    Uses pg_try_advisory_lock which returns immediately (non-blocking).
    If another session holds the lock this returns False without waiting.
    """
    key = derive_project_lock_key(project_id)
    result = await conn.execute(
        text("SELECT pg_try_advisory_lock(:k)"), {"k": key}
    )
    return bool(result.scalar_one())


async def release_project_lock(
    conn: AsyncConnection, project_id: uuid.UUID
) -> None:
    """Release the session-level advisory lock for the given project."""
    key = derive_project_lock_key(project_id)
    await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})
