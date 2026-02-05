"""Add index_mode and gemini_files to folders

Revision ID: c8f2e3a4b5d6
Revises: bbbf8a2da11c
Create Date: 2026-02-04

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'c8f2e3a4b5d6'
down_revision = 'bbbf8a2da11c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create the enum type
    index_mode_enum = postgresql.ENUM('gemini_files', 'chroma', name='indexmode', create_type=False)
    index_mode_enum.create(op.get_bind(), checkfirst=True)
    
    # Add new columns
    op.add_column('folders', sa.Column('index_mode', sa.Enum('gemini_files', 'chroma', name='indexmode'), nullable=True))
    op.add_column('folders', sa.Column('gemini_files', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('folders', 'gemini_files')
    op.drop_column('folders', 'index_mode')
    
    # Drop the enum type
    op.execute('DROP TYPE IF EXISTS indexmode')
