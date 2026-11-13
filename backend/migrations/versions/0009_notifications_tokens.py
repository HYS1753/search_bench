"""알림 채널(Slack·웹훅)과 자동화용 API 토큰

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notification_channels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False, server_default="slack"),
        sa.Column("url_enc", sa.Text(), nullable=False, server_default=""),
        sa.Column("url_hint", sa.String(100), nullable=False, server_default=""),
        sa.Column("events", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_ok", sa.Boolean(), nullable=True),
        sa.Column("last_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("last_sent_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("prefix", sa.String(20), nullable=False),
        sa.Column("token_hash", sa.String(100), nullable=False, unique=True),
        sa.Column("role", sa.String(20), nullable=False, server_default="editor"),
        sa.Column("created_by", sa.String(100), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_table("api_tokens")
    op.drop_table("notification_channels")
