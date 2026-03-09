#!/usr/bin/env bash
# Run Django migrations then start gunicorn.
# Use from repo root: ./run-backend.sh
# Or as Render Start Command (with Root Directory = back_end): chmod +x run.sh && ./run.sh
# Or as Render Start Command (with Root Directory = repo root): chmod +x run-backend.sh && ./run-backend.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/back_end"
python manage.py migrate --noinput
exec gunicorn civitas.wsgi:application --bind 0.0.0.0:${PORT:-8000}
