#!/bin/bash
# Deploy the Civitas RFP scraper to AWS Lambda + EventBridge.
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker installed and running
#   - SAM CLI installed (pip install aws-sam-cli)
#
# Usage:
#   cd civitas/
#   bash webscraping/v2/deploy/deploy.sh
#
# This script:
#   1. Builds the Docker image with Playwright + Chromium
#   2. Pushes it to ECR
#   3. Deploys the SAM template (Lambda + EventBridge schedule)

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="civitas-scraper"
IMAGE_TAG="latest"
STACK_NAME="civitas-scraper"
S3_BUCKET="${AWS_STORAGE_BUCKET_NAME:-civitas-ai}"

echo "=== Civitas Scraper Deployment ==="
echo "Account: $ACCOUNT_ID"
echo "Region:  $REGION"
echo "Bucket:  $S3_BUCKET"

# 1. Create ECR repository (if it doesn't exist)
echo ""
echo "=== Creating ECR repository ==="
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" 2>/dev/null \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION"

# 2. Login to ECR
echo ""
echo "=== Logging into ECR ==="
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# 3. Build Docker image
echo ""
echo "=== Building Docker image ==="
docker build -t "$ECR_REPO:$IMAGE_TAG" -f webscraping/v2/deploy/Dockerfile .

# 4. Tag and push to ECR
echo ""
echo "=== Pushing to ECR ==="
docker tag "$ECR_REPO:$IMAGE_TAG" "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG"
docker push "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG"

# 5. Deploy SAM template
echo ""
echo "=== Deploying Lambda + EventBridge ==="
sam deploy \
  --template-file webscraping/v2/deploy/template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "S3BucketName=$S3_BUCKET" \
    "GroqApiKey=$GROQ_API_KEY" \
    "AnthropicApiKey=${ANTHROPIC_API_KEY:-}" \
  --no-confirm-changeset

echo ""
echo "=== Deployment complete ==="
echo "Lambda function: civitas-rfp-scraper"
echo "Schedule: every 4 hours (default)"
echo ""
echo "To invoke manually:"
echo "  aws lambda invoke --function-name civitas-rfp-scraper --payload '{\"site_id\": \"caleprocure\"}' /tmp/response.json"
echo ""
echo "To check logs:"
echo "  aws logs tail /aws/lambda/civitas-rfp-scraper --follow"
