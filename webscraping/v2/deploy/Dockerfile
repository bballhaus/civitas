# Lambda container image with Playwright + Chromium.
# Uses python:3.11-slim as base (full glibc) with awslambdaric for Lambda compatibility.

FROM public.ecr.aws/docker/library/python:3.11-slim

# Install system deps for Chromium + Lambda RIC
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium dependencies
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libpangocairo-1.0-0 libasound2 libxshmfence1 libx11-xcb1 \
    libxkbcommon0 libgtk-3-0 libdbus-glib-1-2 \
    # Lambda RIC build deps
    g++ make cmake \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps + Lambda Runtime Interface Client
COPY webscraping/v2/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir \
    -r /tmp/requirements.txt \
    awslambdaric

# Install Playwright Chromium in a shared location accessible by Lambda's sandbox user
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN python -m playwright install chromium

# Copy application code
WORKDIR /app
COPY webscraping/__init__.py /app/webscraping/__init__.py
COPY webscraping/v2/ /app/webscraping/v2/

# Run as non-root user for security
RUN useradd -m -u 1000 -s /bin/bash scraper && \
    chown -R scraper:scraper /app /opt/playwright
USER scraper

# Lambda RIC entry point
ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["webscraping.v2.deploy.lambda_handler.handler"]
