"""테스트 데이터 ↔ 비교 세트 연결(저장된 컬럼 연결), 데이터 출처, LLM 생성 작업

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.add_column(sa.Column("suite_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("mapping", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("meta", sa.JSON(), nullable=False, server_default="{}"))
        batch.create_foreign_key("fk_datasets_suite", "suites", ["suite_id"], ["id"], ondelete="SET NULL")
    op.create_table(
        "generation_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("suite_id", sa.Integer(), sa.ForeignKey("suites.id", ondelete="SET NULL"), nullable=True),
        sa.Column("judge_model_id", sa.Integer(), sa.ForeignKey("judge_models.id", ondelete="SET NULL"), nullable=True),
        sa.Column("params", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("stage", sa.String(50), nullable=False, server_default=""),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rows", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("stats", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("tokens_input", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_output", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("judge_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_estimate", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("generation_jobs")
    with op.batch_alter_table("datasets") as batch:
        batch.drop_constraint("fk_datasets_suite", type_="foreignkey")
        batch.drop_column("meta")
        batch.drop_column("mapping")
        batch.drop_column("suite_id")
