#!/bin/bash
# ============================================================================
# Civitas RFP Scraper — AWS Infrastructure Setup
# ============================================================================
#
# Deploys a production-grade scraping pipeline:
#   - ECR repository (container registry)
#   - CodeBuild project (builds Docker image remotely — no Docker needed locally)
#   - Lambda function (runs the scraper from container image)
#   - EventBridge rule (triggers Lambda on schedule)
#   - IAM roles with least-privilege permissions
#
# This is architected for scale: adding a new site means adding one more
# EventBridge rule. The same Lambda handles all sites via the event payload.
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - The civitas repo pushed to GitHub
#
# Usage:
#   cd civitas/
#   bash webscraping/v2/deploy/aws-setup.sh
#
# To add a new scraping schedule for another site:
#   aws events put-rule --name civitas-scrape-SITEID --schedule-expression "rate(48 hours)" --state ENABLED
#   aws events put-targets --rule civitas-scrape-SITEID --targets '[{"Id":"1","Arn":"LAMBDA_ARN","Input":"{\"site_id\":\"SITEID\"}"}]'
# ============================================================================

set -euo pipefail

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
if [ -z "$ACCOUNT_ID" ]; then
    echo "ERROR: AWS CLI not configured. Run 'aws configure' first."
    exit 1
fi

PROJECT_NAME="civitas-scraper"
ECR_REPO="civitas-scraper"
LAMBDA_FUNCTION="civitas-rfp-scraper"
S3_BUCKET="civitas-ai"
CODEBUILD_PROJECT="civitas-scraper-build"

echo "============================================"
echo "  Civitas Scraper — AWS Setup"
echo "============================================"
echo "Account:  $ACCOUNT_ID"
echo "Region:   $REGION"
echo "Bucket:   $S3_BUCKET"
echo ""

# ============================================================================
# Step 1: Create ECR Repository
# ============================================================================
echo "=== Step 1: ECR Repository ==="
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" 2>/dev/null \
    && echo "  ECR repo already exists" \
    || aws ecr create-repository \
        --repository-name "$ECR_REPO" \
        --region "$REGION" \
        --image-scanning-configuration scanOnPush=true \
        --output text --query 'repository.repositoryUri'
echo ""

# ============================================================================
# Step 2: Create IAM Roles
# ============================================================================
echo "=== Step 2: IAM Roles ==="

# Lambda execution role
LAMBDA_ROLE_NAME="${PROJECT_NAME}-lambda-role"
LAMBDA_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"

aws iam get-role --role-name "$LAMBDA_ROLE_NAME" 2>/dev/null && echo "  Lambda role exists" || {
    echo "  Creating Lambda execution role..."
    aws iam create-role \
        --role-name "$LAMBDA_ROLE_NAME" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }' --output text --query 'Role.Arn'

    # Attach basic Lambda execution + S3 access
    aws iam attach-role-policy --role-name "$LAMBDA_ROLE_NAME" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

    aws iam put-role-policy --role-name "$LAMBDA_ROLE_NAME" \
        --policy-name "s3-access" \
        --policy-document "{
            \"Version\": \"2012-10-17\",
            \"Statement\": [{
                \"Effect\": \"Allow\",
                \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\"],
                \"Resource\": [
                    \"arn:aws:s3:::${S3_BUCKET}\",
                    \"arn:aws:s3:::${S3_BUCKET}/*\"
                ]
            }]
        }"

    echo "  Waiting for role to propagate..."
    sleep 10
}

# CodeBuild service role
CODEBUILD_ROLE_NAME="${PROJECT_NAME}-codebuild-role"

aws iam get-role --role-name "$CODEBUILD_ROLE_NAME" 2>/dev/null && echo "  CodeBuild role exists" || {
    echo "  Creating CodeBuild service role..."
    aws iam create-role \
        --role-name "$CODEBUILD_ROLE_NAME" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "codebuild.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }' --output text --query 'Role.Arn'

    # CodeBuild needs: ECR push, Lambda update, CloudWatch Logs, S3 (for cache)
    aws iam put-role-policy --role-name "$CODEBUILD_ROLE_NAME" \
        --policy-name "codebuild-permissions" \
        --policy-document "{
            \"Version\": \"2012-10-17\",
            \"Statement\": [
                {
                    \"Effect\": \"Allow\",
                    \"Action\": [
                        \"ecr:GetAuthorizationToken\",
                        \"ecr:BatchCheckLayerAvailability\",
                        \"ecr:GetDownloadUrlForLayer\",
                        \"ecr:BatchGetImage\",
                        \"ecr:PutImage\",
                        \"ecr:InitiateLayerUpload\",
                        \"ecr:UploadLayerPart\",
                        \"ecr:CompleteLayerUpload\"
                    ],
                    \"Resource\": \"*\"
                },
                {
                    \"Effect\": \"Allow\",
                    \"Action\": [
                        \"lambda:UpdateFunctionCode\",
                        \"lambda:GetFunction\"
                    ],
                    \"Resource\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_FUNCTION}\"
                },
                {
                    \"Effect\": \"Allow\",
                    \"Action\": [
                        \"logs:CreateLogGroup\",
                        \"logs:CreateLogStream\",
                        \"logs:PutLogEvents\"
                    ],
                    \"Resource\": \"*\"
                }
            ]
        }"

    sleep 10
}

echo ""

# ============================================================================
# Step 3: Create CodeBuild Project
# ============================================================================
echo "=== Step 3: CodeBuild Project ==="

CODEBUILD_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${CODEBUILD_ROLE_NAME}"

aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT" --query 'projects[0].name' --output text 2>/dev/null | grep -q "$CODEBUILD_PROJECT" \
    && echo "  CodeBuild project already exists" \
    || {
    echo "  Creating CodeBuild project..."
    aws codebuild create-project \
        --name "$CODEBUILD_PROJECT" \
        --description "Builds the Civitas scraper Docker image and pushes to ECR" \
        --source '{
            "type": "GITHUB",
            "location": "https://github.com/bballhaus/civitas.git",
            "buildspec": "webscraping/v2/deploy/buildspec.yml",
            "gitCloneDepth": 1
        }' \
        --artifacts '{"type": "NO_ARTIFACTS"}' \
        --environment "{
            \"type\": \"LINUX_CONTAINER\",
            \"computeType\": \"BUILD_GENERAL1_MEDIUM\",
            \"image\": \"aws/codebuild/amazonlinux2-x86_64-standard:5.0\",
            \"privilegedMode\": true,
            \"environmentVariables\": [
                {\"name\": \"AWS_DEFAULT_REGION\", \"value\": \"${REGION}\"},
                {\"name\": \"AWS_ACCOUNT_ID\", \"value\": \"${ACCOUNT_ID}\"}
            ]
        }" \
        --service-role "$CODEBUILD_ROLE_ARN" \
        --region "$REGION" \
        --output text --query 'project.name'
}
echo ""

# ============================================================================
# Step 4: Build and push the Docker image (via CodeBuild)
# ============================================================================
echo "=== Step 4: Building Docker image via CodeBuild ==="
echo "  Starting build (this takes ~5 minutes)..."
BUILD_ID=$(aws codebuild start-build \
    --project-name "$CODEBUILD_PROJECT" \
    --source-version "webscraping" \
    --region "$REGION" \
    --query 'build.id' --output text)
echo "  Build ID: $BUILD_ID"
echo ""
echo "  Monitor at: https://${REGION}.console.aws.amazon.com/codesuite/codebuild/projects/${CODEBUILD_PROJECT}/build/${BUILD_ID}"
echo ""

# Wait for build to complete
echo "  Waiting for build to complete..."
while true; do
    STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text 2>/dev/null)
    PHASE=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].currentPhase' --output text 2>/dev/null)
    echo "    Status: $STATUS | Phase: $PHASE"
    if [ "$STATUS" = "SUCCEEDED" ]; then
        echo "  Build succeeded!"
        break
    elif [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "FAULT" ] || [ "$STATUS" = "STOPPED" ]; then
        echo "  ERROR: Build $STATUS"
        echo "  Check logs at the URL above"
        exit 1
    fi
    sleep 15
done
echo ""

# ============================================================================
# Step 5: Create Lambda Function
# ============================================================================
echo "=== Step 5: Lambda Function ==="
LAMBDA_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:latest"

aws lambda get-function --function-name "$LAMBDA_FUNCTION" 2>/dev/null && {
    echo "  Lambda function exists, updating..."
    aws lambda update-function-code \
        --function-name "$LAMBDA_FUNCTION" \
        --image-uri "$IMAGE_URI" \
        --output text --query 'FunctionArn'
} || {
    echo "  Creating Lambda function..."
    aws lambda create-function \
        --function-name "$LAMBDA_FUNCTION" \
        --package-type Image \
        --code "ImageUri=${IMAGE_URI}" \
        --role "$LAMBDA_ROLE_ARN" \
        --timeout 900 \
        --memory-size 2048 \
        --environment "Variables={AWS_STORAGE_BUCKET_NAME=${S3_BUCKET},GROQ_API_KEY=${GROQ_API_KEY:-},ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}}" \
        --region "$REGION" \
        --output text --query 'FunctionArn'
}

# Wait for Lambda to be active
echo "  Waiting for Lambda to be active..."
aws lambda wait function-active-v2 --function-name "$LAMBDA_FUNCTION" 2>/dev/null || sleep 10
echo ""

# ============================================================================
# Step 6: Create EventBridge Schedule
# ============================================================================
echo "=== Step 6: EventBridge Schedule ==="
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_FUNCTION}"

# Cal eProcure — every 4 hours
RULE_NAME="civitas-scrape-caleprocure"
aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "rate(48 hours)" \
    --state ENABLED \
    --description "Scrape Cal eProcure every 4 hours" \
    --region "$REGION" \
    --output text --query 'RuleArn'

aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "[{\"Id\":\"1\",\"Arn\":\"${LAMBDA_ARN}\",\"Input\":\"{\\\"site_id\\\":\\\"caleprocure\\\"}\"}]" \
    --region "$REGION" > /dev/null

# Grant EventBridge permission to invoke Lambda
aws lambda add-permission \
    --function-name "$LAMBDA_FUNCTION" \
    --statement-id "eventbridge-caleprocure" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
    2>/dev/null || true

echo "  Schedule created: Cal eProcure every 4 hours"
echo ""

# ============================================================================
# Done
# ============================================================================
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Lambda:    $LAMBDA_FUNCTION"
echo "Schedule:  Every 4 hours (Cal eProcure)"
echo "S3 data:   s3://${S3_BUCKET}/scrapes/v2/manifests/"
echo ""
echo "Useful commands:"
echo "  # Invoke manually"
echo "  aws lambda invoke --function-name $LAMBDA_FUNCTION --payload '{\"site_id\": \"caleprocure\"}' /tmp/response.json && cat /tmp/response.json"
echo ""
echo "  # Check logs"
echo "  aws logs tail /aws/lambda/$LAMBDA_FUNCTION --follow"
echo ""
echo "  # Add another site schedule"
echo "  aws events put-rule --name civitas-scrape-SITEID --schedule-expression 'rate(48 hours)' --state ENABLED"
echo "  aws events put-targets --rule civitas-scrape-SITEID --targets '[{\"Id\":\"1\",\"Arn\":\"${LAMBDA_ARN}\",\"Input\":\"{\\\\\"site_id\\\\\":\\\\\"SITEID\\\\\"}\"}]'"
echo ""
echo "  # Rebuild after code changes"
echo "  aws codebuild start-build --project-name $CODEBUILD_PROJECT --source-version webscraping"
