"""사람 검수를 검수자별로: run_cases.human_by = {검수자: {"grades": {key: {grade, note, at}}, "pairwise": {후보: 선호}}}

기존 human_judgments/human_pairwise 는 '기존 검수' 검수자로 옮기고, 앞으로 두 열은 검수자들의 합의(중앙값·다수결) 값으로 쓴다.

Revision ID: 0007
Revises: 0006
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_cases") as batch:
        batch.add_column(sa.Column("human_by", sa.JSON(), nullable=False, server_default="{}"))
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, human_judgments, human_pairwise FROM run_cases")).fetchall()
    for rid, hj, hp in rows:
        hj = json.loads(hj) if isinstance(hj, str) else (hj or {})
        hp = json.loads(hp) if isinstance(hp, str) else (hp or {})
        if hj or hp:
            by = {"기존 검수": {"grades": hj, "pairwise": hp}}
            bind.execute(sa.text("UPDATE run_cases SET human_by = :b WHERE id = :i"), {"b": json.dumps(by, ensure_ascii=False), "i": rid})


def downgrade() -> None:
    with op.batch_alter_table("run_cases") as batch:
        batch.drop_column("human_by")
