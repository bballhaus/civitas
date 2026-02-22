"""
Bearer token authentication. Token is stored in AWS DynamoDB; no session cookie needed.
"""
from django.contrib.auth import get_user_model
from rest_framework import authentication

from .services.token_storage import get_user_id_for_token


class BearerTokenAuthentication(authentication.BaseAuthentication):
    """
    Authenticate using Authorization: Bearer <token>. Token is looked up in AWS DynamoDB.
    """
    keyword = 'Bearer'

    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION')
        if not auth_header or not auth_header.startswith(self.keyword + ' '):
            return None
        token = auth_header[len(self.keyword) + 1:].strip()
        if not token:
            return None
        user_id = get_user_id_for_token(token)
        if user_id is None:
            return None
        User = get_user_model()
        try:
            user = User.objects.get(pk=user_id)
            return (user, token)
        except User.DoesNotExist:
            return None
