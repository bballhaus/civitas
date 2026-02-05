from rest_framework import status, generics
from rest_framework.permissions import IsAuthenticated, AllowAny
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


class ProfileExtractView(APIView):
    """Accept document uploads and parse them (minimal version - just parse, no aggregation)."""

    permission_classes = [AllowAny]  # No auth required for initial profile setup
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        documents = request.FILES.getlist('documents')
        if not documents:
            return Response(
                {'error': 'No files provided. Send multipart form with "documents" field (multiple files).'},
                status=status.HTTP_400_BAD_REQUEST
            )

        all_extracted = []
        errors = []

        # Process each document
        for doc in documents:
            try:
                extracted = extract_metadata_from_document(doc)
                all_extracted.append(extracted)
            except ExtractionError as e:
                errors.append({'file': doc.name, 'error': str(e)})

        if not all_extracted:
            error_message = 'Failed to extract data from any documents.'
            if errors:
                error_details = '; '.join([f"{e.get('file', 'Unknown')}: {e.get('error', 'Unknown error')}" for e in errors])
                error_message += f' Details: {error_details}'
            return Response(
                {'error': error_message, 'details': errors},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Just return success - parsing is done
        return Response({
            'success': True,
            'processed': len(all_extracted),
            'errors': errors if errors else None
        })


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


class UserProfileView(generics.RetrieveUpdateAPIView):
    """Get or update current user's profile (background from past contracts)."""
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
