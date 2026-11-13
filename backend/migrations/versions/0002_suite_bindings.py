"""비교 세트: API 별 입력 연결·결과 동일성 규칙

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("suites") as batch:
        batch.add_column(sa.Column("match_mode", sa.String(length=10), nullable=False, server_default="id"))
    with op.batch_alter_table("suite_targets") as batch:
        batch.add_column(sa.Column("input_bindings", sa.JSON(), nullable=False, server_default="{}"))
        batch.add_column(sa.Column("match", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    with op.batch_alter_table("suite_targets") as batch:
        batch.drop_column("match")
        batch.drop_column("input_bindings")
    with op.batch_alter_table("suites") as batch:
        batch.drop_column("match_mode")
