from rest_framework import status, generics
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.views import APIView

from .models import Contract, UserProfile
from .serializers import ContractSerializer, UserProfileSerializer
from .services import extract_metadata_from_document, ExtractionError


class ContractExtractView(APIView):
    """Extract metadata from a document without saving. Returns structured JSON."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        document = request.FILES.get('document')
        if not document:
            return Response(
                {'document': 'No file provided. Send multipart form with "document" field.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        try:
            data = extract_metadata_from_document(document)
            return Response(data)
        except ExtractionError as e:
            return Response({'document': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class ContractListCreateView(generics.ListCreateAPIView):
    """List and create user contracts."""
    serializer_class = ContractSerializer
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        return Contract.objects.filter(user=self.request.user)


class ContractDetailView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update, or delete a contract."""
    serializer_class = ContractSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Contract.objects.filter(user=self.request.user)

    def perform_destroy(self, instance):
        user = instance.user
        instance.delete()
        # Refresh profile after contract deletion
        try:
            profile = UserProfile.objects.get(user=user)
            profile.refresh_from_contracts()
        except UserProfile.DoesNotExist:
            pass


class UserProfileView(generics.RetrieveAPIView):
    """Get current user's profile (background from past contracts)."""
    serializer_class = UserProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        profile, _ = UserProfile.objects.get_or_create(user=self.request.user)
        return profile


class UserProfileRefreshView(generics.GenericAPIView):
    """Manually refresh profile from contracts."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.refresh_from_contracts()
        return Response(
            UserProfileSerializer(profile).data,
            status=status.HTTP_200_OK
        )
