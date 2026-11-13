"""Alembic 환경 — 앱 설정의 SQLite 경로를 쓴다."""

from alembic import context

from app import models  # noqa: F401  (메타데이터 등록)
from app.db import Base, get_engine

target_metadata = Base.metadata


def run_migrations_online() -> None:
    connectable = context.config.attributes.get("connection")
    if connectable is not None:
        context.configure(connection=connectable, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    with get_engine().connect() as connection:
        # 테이블을 다시 만드는(batch) 단계에서 ON DELETE CASCADE 로 자식 행이 지워지지 않게(app.main.migrate 와 같은 이유)
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
