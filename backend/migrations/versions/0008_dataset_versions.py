"""테스트 데이터 버전: 저장할 때마다 행 전체 사본을 남기고, 실행은 어떤 버전을 썼는지 기록한다

Revision ID: 0008
Revises: 0007
"""

import json
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "dataset_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("columns", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("rows", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(100), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("dataset_id", "version"),
    )
    # 기존 데이터는 지금 상태를 v1 로
    bind = op.get_bind()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for did, cols in bind.execute(sa.text("SELECT id, columns FROM datasets")).fetchall():
        rows = [json.loads(r) if isinstance(r, str) else r for (r,) in bind.execute(
            sa.text("SELECT data FROM dataset_rows WHERE dataset_id = :d ORDER BY row_index"), {"d": did}).fetchall()]
        bind.execute(sa.text("INSERT INTO dataset_versions (dataset_id, version, columns, rows, row_count, note, created_by, created_at) "
                             "VALUES (:d, 1, :c, :r, :n, '처음 버전', '', :t)"),
                     {"d": did, "c": cols if isinstance(cols, str) else json.dumps(cols, ensure_ascii=False),
                      "r": json.dumps(rows, ensure_ascii=False), "n": len(rows), "t": now})
        bind.execute(sa.text("UPDATE datasets SET version = 1 WHERE id = :d"), {"d": did})


def downgrade() -> None:
    op.drop_table("dataset_versions")
    with op.batch_alter_table("datasets") as batch:
        batch.drop_column("version")
