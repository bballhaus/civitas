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

# Install system dependencies for Playwright/Chromium
RUN dnf install -y \
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
    && dnf clean all

# Copy requirements and install Python deps
COPY webscraping/v2/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Install Playwright Chromium
RUN python -m playwright install chromium

# Copy application code
COPY webscraping/ ${LAMBDA_TASK_ROOT}/webscraping/

# Lambda handler
CMD ["webscraping.v2.deploy.lambda_handler.handler"]
