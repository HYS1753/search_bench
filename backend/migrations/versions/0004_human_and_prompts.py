"""사람 판정(케이스별 항목 등급·목록 선호)과 평가 기준별 판정 프롬프트(고급 설정)

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_cases") as batch:
        batch.add_column(sa.Column("human_judgments", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("human_pairwise", sa.JSON(), nullable=False, server_default="{}"))
    with op.batch_alter_table("criteria") as batch:
        batch.add_column(sa.Column("system_prompt", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("item_template", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("pairwise_template", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    with op.batch_alter_table("criteria") as batch:
        batch.drop_column("pairwise_template")
        batch.drop_column("item_template")
        batch.drop_column("system_prompt")
    with op.batch_alter_table("run_cases") as batch:
        batch.drop_column("human_pairwise")
        batch.drop_column("human_judgments")
