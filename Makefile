.PHONY: up down reset migrate logs

## Start all services in the background (builds images if needed).
up:
	docker compose up -d --build

## Stop all services.
down:
	docker compose down

## Wipe all data volumes and rebuild from scratch.
reset:
	docker compose down -v
	docker compose up -d --build

## Run pending Alembic migrations inside the running backend container.
migrate:
	docker compose exec backend alembic -c alembic.ini upgrade head

## Tail live logs from the backend container (Ctrl-C to stop).
logs:
	docker compose logs -f backend
