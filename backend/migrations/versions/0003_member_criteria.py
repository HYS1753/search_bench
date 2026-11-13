"""비교 세트: 후보(API)마다 평가 기준

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("suite_targets") as batch:
        batch.add_column(sa.Column("criteria_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_suite_targets_criteria", "criteria", ["criteria_id"], ["id"], ondelete="SET NULL")
    # 기존 세트는 세트 기본 기준을 후보마다 복사
    op.execute(
        "UPDATE suite_targets SET criteria_id = (SELECT default_criteria_id FROM suites WHERE suites.id = suite_targets.suite_id) "
        "WHERE is_baseline = 0"
    )


def downgrade() -> None:
    with op.batch_alter_table("suite_targets") as batch:
        batch.drop_constraint("fk_suite_targets_criteria", type_="foreignkey")
        batch.drop_column("criteria_id")
