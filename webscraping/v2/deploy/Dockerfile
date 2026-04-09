# Lambda container image with Playwright + Chromium for browser-based scrapers.
# Single-stage build using the Lambda base image directly.

FROM public.ecr.aws/lambda/python:3.11

# The Lambda Python 3.11 image is based on Amazon Linux 2023.
# Determine available package manager and install Chromium dependencies.
RUN (command -v dnf && dnf install -y nss atk cups-libs libdrm libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib at-spi2-atk gtk3 libxkbcommon && dnf clean all) || \
    (command -v microdnf && microdnf install -y nss atk cups-libs libdrm libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib && microdnf clean all) || \
    (command -v yum && yum install -y nss atk cups-libs libdrm libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib && yum clean all) || \
    echo "WARNING: No package manager found, Chromium may not work"

# Install Python dependencies
COPY webscraping/v2/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Install Playwright Chromium
RUN python -m playwright install chromium

# Copy application code
COPY webscraping/__init__.py ${LAMBDA_TASK_ROOT}/webscraping/__init__.py
COPY webscraping/v2/ ${LAMBDA_TASK_ROOT}/webscraping/v2/

# Lambda handler
CMD ["webscraping.v2.deploy.lambda_handler.handler"]
