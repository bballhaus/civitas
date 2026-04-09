# Lambda container image with Playwright + Chromium for browser-based scrapers.
#
# Uses multi-stage build:
#   Stage 1: Install Playwright + Chromium in a full Python image
#   Stage 2: Copy to Lambda runtime

# --- Stage 1: Build with full Python + Playwright ---
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY webscraping/v2/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --target /opt/python -r /tmp/requirements.txt

RUN pip install playwright && python -m playwright install chromium
RUN python -m playwright install-deps chromium

# --- Stage 2: Lambda runtime ---
FROM public.ecr.aws/lambda/python:3.11

# Copy Chromium deps (installed by playwright install-deps in stage 1)
RUN microdnf install -y \
    nss \
    atk \
    cups-libs \
    libdrm \
    libXcomposite \
    libXdamage \
    libXrandr \
    mesa-libgbm \
    pango \
    alsa-lib \
    at-spi2-atk \
    gtk3 \
    libxkbcommon \
    && microdnf clean all

# Copy Python packages from builder
COPY --from=builder /opt/python ${LAMBDA_TASK_ROOT}

# Copy Playwright browsers from builder
COPY --from=builder /root/.cache/ms-playwright /root/.cache/ms-playwright

# Copy application code
COPY webscraping/__init__.py ${LAMBDA_TASK_ROOT}/webscraping/__init__.py
COPY webscraping/v2/ ${LAMBDA_TASK_ROOT}/webscraping/v2/

# Lambda handler
CMD ["webscraping.v2.deploy.lambda_handler.handler"]
