.PHONY: dev start stop logs logs-backend logs-frontend build clean reset-db migrate backend-shell frontend-shell db-shell

dev:
	docker compose up

start:
	docker compose up -d

stop:
	docker compose down

logs:
	docker compose logs -f

logs-backend:
	docker compose logs -f backend

logs-frontend:
	docker compose logs -f frontend

build:
	docker compose build

clean:
	docker compose down -v --rmi local

reset-db:
	docker compose down -v
	docker compose up -d db
	@echo "Database reset. Run 'make start' to start all services."

migrate:
	docker compose exec backend alembic upgrade head

migrate-create:
	docker compose exec backend alembic revision --autogenerate -m "$(name)"

backend-shell:
	docker compose exec backend bash

frontend-shell:
	docker compose exec frontend sh

db-shell:
	docker compose exec db psql -U talk2folder -d talk2folder

setup-backend:
	cd backend && uv venv && uv pip install -r requirements.txt

setup-frontend:
	cd frontend && bun install

setup: setup-backend setup-frontend
