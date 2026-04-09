# Lambda container image with Playwright + Chromium for browser-based scrapers.
#
# Build:
#   docker build -t civitas-scraper -f webscraping/v2/deploy/Dockerfile .
#
# Test locally:
#   docker run -p 9000:8080 \
#     -e AWS_ACCESS_KEY_ID=... \
#     -e AWS_SECRET_ACCESS_KEY=... \
#     -e AWS_STORAGE_BUCKET_NAME=civitas-ai \
#     -e GROQ_API_KEY=... \
#     civitas-scraper
#
#   curl -X POST "http://localhost:9000/2015-03-31/functions/function/invocations" \
#     -d '{"site_id": "caleprocure"}'

FROM public.ecr.aws/lambda/python:3.11

# Install system dependencies for Chromium (Amazon Linux 2023)
RUN dnf install -y \
    nss \
    nspr \
    at-spi2-atk \
    cups-libs \
    libdrm \
    libXcomposite \
    libXdamage \
    libXrandr \
    libXScrnSaver \
    mesa-libgbm \
    pango \
    alsa-lib \
    libXtst \
    gtk3 \
    libxkbcommon \
    dbus-glib \
    wget \
    && dnf clean all

# Copy requirements and install Python deps
COPY webscraping/v2/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Install Playwright Chromium + its system deps
RUN python -m playwright install chromium
# Playwright install-deps doesn't support Amazon Linux — the dnf packages above cover it

# Copy application code (webscraping package at the task root)
COPY webscraping/__init__.py ${LAMBDA_TASK_ROOT}/webscraping/__init__.py
COPY webscraping/v2/ ${LAMBDA_TASK_ROOT}/webscraping/v2/

# Lambda handler
CMD ["webscraping.v2.deploy.lambda_handler.handler"]
