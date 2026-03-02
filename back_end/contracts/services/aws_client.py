"""
Shared boto3 credential kwargs from Django settings (.env).
Use these so AWS calls use .env credentials instead of shell/env (which can be stale).
"""
import logging
from django.conf import settings

logger = logging.getLogger(__name__)


def get_boto3_kwargs():
    """Return kwargs for boto3.resource() or boto3.client() using settings (from .env)."""
    region = getattr(settings, 'AWS_REGION', 'us-east-1')
    kw = {'region_name': region}
    ak = getattr(settings, 'AWS_ACCESS_KEY_ID', None)
    sk = getattr(settings, 'AWS_SECRET_ACCESS_KEY', None)
    tok = getattr(settings, 'AWS_SESSION_TOKEN', None)
    if ak and sk:
        kw['aws_access_key_id'] = ak
        kw['aws_secret_access_key'] = sk
        if tok:
            kw['aws_session_token'] = tok
            # If you use long-term IAM user keys (no temporary creds), remove AWS_SESSION_TOKEN from .env;
            # a stale token causes "The security token included in the request is invalid".
    else:
        # .env missing keys: boto3 will use default chain (shell / ~/.aws/credentials)
        logger.warning(
            "AWS credentials from .env incomplete: AWS_ACCESS_KEY_ID=%s, AWS_SECRET_ACCESS_KEY=%s. "
            "Add both to back_end/.env for DynamoDB/S3.",
            "set" if ak else "not set",
            "set" if sk else "not set",
        )
    return kw
