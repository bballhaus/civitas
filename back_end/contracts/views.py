import logging

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.middleware.csrf import get_token
from rest_framework import status, generics
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.views import APIView

from .models import Contract, UserProfile
from .serializers import ContractSerializer, UserProfileSerializer, UserWithProfileSerializer
from .services import (
    extract_metadata_from_document,
    ExtractionError,
    get_profile,
    save_profile,
    get_or_create_profile,
    refresh_profile_from_contracts,
    profile_dict_to_object,
    list_contracts,
    get_contract,
    create_contract,
    update_contract,
    delete_contract,
    contract_dict_to_object,
)
from .services.token_storage import create_token, delete_token

logger = logging.getLogger(__name__)


class CsrfView(APIView):
    """Return CSRF token for cross-origin requests. Call before login/signup."""

    permission_classes = [AllowAny]

    def get(self, request):
        token = get_token(request)
        return Response({'csrfToken': token})


class SignupView(APIView):
    """Create a new user. Auto-creates UserProfile and optionally logs in."""

    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get('username', '').strip()
        password = request.data.get('password')
        email = request.data.get('email', '').strip()

        if not username or not password:
            return Response(
                {'error': 'username and password required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        User = get_user_model()
        if User.objects.filter(username__iexact=username).exists():
            return Response(
                {'error': 'A user with that username already exists'},
                status=status.HTTP_400_BAD_REQUEST
            )

        user = User.objects.create_user(
            username=username,
            password=password,
            email=email or '',
        )
        logger.info("Signup: creating profile in AWS for user_id=%s username=%s", user.id, user.username)
        get_or_create_profile(user.id)
        login(request, user)
        auth_token = create_token(user.id)
        logger.info("Signup successful: user_id=%s username=%s", user.id, user.username)

        data = {'user_id': user.id, 'username': user.username}
        if auth_token:
            data['token'] = auth_token
        return Response(data, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    """Login with username and password. Uses Django session auth."""

    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get('username')
        password = request.data.get('password')
        if not username or not password:
            return Response(
                {'error': 'username and password required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        user = authenticate(request, username=username, password=password)
        if user is None:
            logger.info("Login failed: invalid credentials for username=%s", username)
            return Response(
                {'error': 'Invalid credentials'},
                status=status.HTTP_401_UNAUTHORIZED
            )
        login(request, user)
        auth_token = create_token(user.id)
        logger.info("Login successful: user_id=%s username=%s", user.id, user.username)

        data = {'user_id': user.id, 'username': user.username}
        if auth_token:
            data['token'] = auth_token
        return Response(data)


class LogoutView(APIView):
    """Log out: invalidate Bearer token in AWS (if sent) and flush session."""

    permission_classes = [AllowAny]

    def post(self, request):
        if getattr(request, 'auth', None) and isinstance(request.auth, str):
            delete_token(request.auth)
            logger.info("Logout: Bearer token deleted from AWS")
        if request.user.is_authenticated:
            logger.info("Logout: removing session key for user_id=%s", request.user.id)
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class CurrentUserView(APIView):
    """Return current user (user_id, username) and optionally profile. Profile from S3 only when include_profile=1."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        include_profile = request.query_params.get('include_profile', '').lower() in ('1', 'true', 'yes')
        if include_profile:
            logger.info("Auth/me: fetching user + profile from S3 for user_id=%s username=%s", user.id, user.username)
            profile_dict = get_or_create_profile(user.id)
            profile = profile_dict_to_object(profile_dict)
            serializer = UserWithProfileSerializer({
                'user': user,
                'profile': profile,
            })
            logger.info("Auth/me: returning user + profile for user_id=%s", user.id)
        else:
            logger.info("Auth/me: returning user only (no S3) for user_id=%s username=%s", user.id, user.username)
            serializer = UserWithProfileSerializer({
                'user': user,
                'profile': None,
            })
        return Response(serializer.data)


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
    """Extract company profile data from multiple contract documents."""

    permission_classes = [AllowAny]  
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

        # Aggregate data into company profile format
        profile_data = self._aggregate_to_profile(all_extracted)

        return Response({
            'profile': profile_data,
            'processed': len(all_extracted),
            'errors': errors if errors else None
        })

    def _aggregate_to_profile(self, extracted_list):
        """Aggregate multiple contract extractions into a single company profile."""
        # Collect all unique values
        industries = set()
        certifications = set()
        clearances = set()
        naics_codes = set()
        work_cities = set()
        work_counties = set()
        capabilities = set()
        agency_experience = set()
        contract_types = set()
        size_statuses = set()
        past_performance_parts = []
        company_names = set()
        total_contract_value = 0

        for extracted in extracted_list:
            features = extracted.get('features', {})
            issuing_agency = extracted.get('issuing_agency', '')
            contractor_name = extracted.get('contractor_name', '')
            jurisdiction = extracted.get('jurisdiction', {})
            
            # Company name from contractor_name (the actual company that won the contract)
            if contractor_name and contractor_name.strip():
                company_names.add(contractor_name.strip())
            
            # Agency experience (the government agency that issued the contract)
            if issuing_agency and issuing_agency != 'Unknown':
                agency_experience.add(issuing_agency)
            
            # Work locations from jurisdiction
            city = jurisdiction.get('city')
            county = jurisdiction.get('county')
            if city:
                work_cities.add(city)
            if county:
                work_counties.add(county)
            
            # NAICS codes
            naics = features.get('naics_codes', [])
            for code in naics:
                if code:
                    naics_codes.add(str(code))
            
            # Clearances
            clearances_list = features.get('required_clearances', [])
            for clearance in clearances_list:
                if clearance:
                    clearances.add(clearance)
            
            # Contract value
            value_str = features.get('contract_value_estimate', '')
            if value_str:
                try:
                    # Remove $ and commas, convert to float
                    value_clean = value_str.replace('$', '').replace(',', '').strip()
                    if value_clean:
                        total_contract_value += float(value_clean)
                except (ValueError, TypeError):
                    pass
            
            # Industries from industry_tags
            industry_tags = features.get('industry_tags', [])
            for tag in industry_tags:
                # Map common tags to our industry list
                tag_lower = tag.lower()
                if 'it' in tag_lower or 'software' in tag_lower or 'tech' in tag_lower:
                    industries.add('IT Services')
                elif 'construction' in tag_lower or 'build' in tag_lower:
                    industries.add('Construction')
                elif 'health' in tag_lower or 'medical' in tag_lower:
                    industries.add('Healthcare')
                elif 'engineer' in tag_lower:
                    industries.add('Engineering')
                elif 'consult' in tag_lower:
                    industries.add('Consulting')
                elif 'manufactur' in tag_lower:
                    industries.add('Manufacturing')
                elif 'research' in tag_lower or 'development' in tag_lower:
                    industries.add('Research & Development')
                elif 'logistics' in tag_lower:
                    industries.add('Logistics')
                elif 'security' in tag_lower:
                    industries.add('Security')
                elif 'education' in tag_lower:
                    industries.add('Education')
            
            # Certifications
            certs = features.get('required_certifications', [])
            for cert in certs:
                # Map to our certification list
                cert_lower = cert.lower()
                if 'iso 9001' in cert_lower:
                    certifications.add('ISO 9001')
                elif 'iso 27001' in cert_lower:
                    certifications.add('ISO 27001')
                elif 'cmmi' in cert_lower:
                    certifications.add('CMMI')
                elif 'fedramp' in cert_lower:
                    certifications.add('FedRAMP')
                elif 'soc 2' in cert_lower or 'soc2' in cert_lower:
                    certifications.add('SOC 2')
                elif 'nist' in cert_lower:
                    certifications.add('NIST 800-53')
                elif 'hipaa' in cert_lower:
                    certifications.add('HIPAA Compliance')
                elif 'pci' in cert_lower:
                    certifications.add('PCI DSS')
                elif 'itar' in cert_lower:
                    certifications.add('ITAR')
                elif 'gsa' in cert_lower:
                    certifications.add('GSA Schedule')
                elif 'naics' in cert_lower:
                    certifications.add('NAICS Codes')
            
            # Capabilities from work_description and industry_tags
            work_desc = features.get('work_description', '').lower()
            for tag in industry_tags:
                tag_lower = tag.lower()
                if 'software' in tag_lower or 'software' in work_desc:
                    capabilities.add('Software Development')
                if 'cloud' in tag_lower or 'cloud' in work_desc:
                    capabilities.add('Cloud Services')
                if 'cyber' in tag_lower or 'security' in work_desc:
                    capabilities.add('Cybersecurity')
                if 'data' in tag_lower or 'analytics' in work_desc:
                    capabilities.add('Data Analytics')
                if 'project' in work_desc or 'management' in work_desc:
                    capabilities.add('Project Management')
                if 'integration' in work_desc or 'system' in work_desc:
                    capabilities.add('System Integration')
                if 'network' in work_desc:
                    capabilities.add('Network Infrastructure')
                if 'database' in work_desc:
                    capabilities.add('Database Management')
                if 'web' in work_desc:
                    capabilities.add('Web Development')
                if 'mobile' in work_desc:
                    capabilities.add('Mobile Development')
                if 'ai' in work_desc or 'ml' in work_desc or 'machine learning' in work_desc:
                    capabilities.add('AI/ML Services')
                if 'devops' in work_desc:
                    capabilities.add('DevOps')
                if 'qa' in work_desc or 'quality' in work_desc:
                    capabilities.add('Quality Assurance')
                if 'writing' in work_desc or 'technical' in work_desc:
                    capabilities.add('Technical Writing')
                if 'training' in work_desc or 'support' in work_desc:
                    capabilities.add('Training & Support')
            
            # Contract types - infer from contract structure
            # Most government contracts are competitive, fixed price, or time & materials
            contract_types.add('Competitive')
            if 'fixed' in work_desc or 'firm' in work_desc:
                contract_types.add('Fixed Price')
            if 'time' in work_desc or 'material' in work_desc:
                contract_types.add('Time & Materials')
            
            # Past performance description
            title = extracted.get('title', '')
            value = features.get('contract_value_estimate', '')
            if title or value:
                perf_text = f"Successfully completed contract"
                if title:
                    perf_text += f": {title}"
                if value:
                    perf_text += f" (Value: {value})"
                if issuing_agency and issuing_agency != 'Unknown':
                    perf_text += f" for {issuing_agency}"
                past_performance_parts.append(perf_text)

        # Build past performance summary
        past_performance = " ".join(past_performance_parts)
        if not past_performance:
            past_performance = f"Successfully completed {len(extracted_list)} contract{'s' if len(extracted_list) > 1 else ''} in various government sectors."

        # Format total contract value
        total_value_str = str(int(total_contract_value)) if total_contract_value > 0 else ''
        
        # Filter out None, null, empty strings, and 'null' strings from all arrays
        def filter_valid_items(items):
            return [item for item in items if item and item != 'null' and item != 'None' and str(item).strip() != '']
        
        return {
            'companyName': list(company_names)[0] if company_names else '',
            'industry': sorted(filter_valid_items(list(industries))),
            'sizeStatus': sorted(filter_valid_items(list(size_statuses))),
            'certifications': sorted(filter_valid_items(list(certifications))),
            'clearances': sorted(filter_valid_items(list(clearances))),
            'naicsCodes': sorted(filter_valid_items(list(naics_codes))),
            'workCities': sorted(filter_valid_items(list(work_cities))),
            'workCounties': sorted(filter_valid_items(list(work_counties))),
            'capabilities': sorted(filter_valid_items(list(capabilities))),
            'agencyExperience': sorted(filter_valid_items(list(agency_experience))),
            'contractTypes': sorted(filter_valid_items(list(contract_types))),
            'contractCount': len(extracted_list),
            'totalPastContractValue': total_value_str,
            'pastPerformance': past_performance,
            'strategicGoals': '',  # Not extractable from contracts
        }


class ContractListCreateView(generics.ListCreateAPIView):
    """List and create user contracts. Stored in S3 (files + user JSON)."""
    serializer_class = ContractSerializer
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        return []  # list() reads from S3 user JSON

    def list(self, request, *args, **kwargs):
        contracts = list_contracts(request.user.id)
        objs = [contract_dict_to_object(c) for c in contracts]
        serializer = self.get_serializer(objs, many=True)
        return Response(serializer.data)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data.copy()
        raw = getattr(request.data, 'data', request.data) or {}
        def _dict(key):
            v = raw.get(key) if isinstance(raw, dict) else getattr(raw, key, None)
            if isinstance(v, dict):
                return v
            if isinstance(v, str):
                try:
                    import json
                    return json.loads(v) or {}
                except Exception:
                    return {}
            return {}
        jur = _dict('jurisdiction')
        feats = _dict('features')
        dts = _dict('dates')
        doc = data.get('document')
        # When a file is uploaded, always parse it to extract metadata, then save contract and update user JSON
        extract = raw.get('extract') if isinstance(raw, dict) else getattr(raw, 'extract', None)
        skip_extract = extract in (False, 'false', '0')
        if doc and not skip_extract:
            try:
                extracted = extract_metadata_from_document(doc)
                ej = extracted.get('jurisdiction') or {}
                ef = extracted.get('features') or {}
                ed = extracted.get('dates') or {}
                jur = {**ej, **jur}
                feats = {**ef, **feats}
                dts = {**ed, **dts}
                if not data.get('issuing_agency'):
                    data['issuing_agency'] = extracted.get('issuing_agency', 'Unknown')
                if not data.get('title') and extracted.get('title'):
                    data['title'] = extracted['title']
                if not data.get('rfp_id') and extracted.get('rfp_id'):
                    data['rfp_id'] = extracted['rfp_id']
                if not data.get('contractor_name') and extracted.get('contractor_name'):
                    data['contractor_name'] = extracted['contractor_name']
            except ExtractionError:
                pass
        metadata = {
            'title': data.get('title', ''),
            'contractor_name': data.get('contractor_name', ''),
            'rfp_id': data.get('rfp_id', ''),
            'issuing_agency': data.get('issuing_agency', 'Unknown'),
            'jurisdiction_state': jur.get('state', 'CA'),
            'jurisdiction_county': jur.get('county', ''),
            'jurisdiction_city': jur.get('city', ''),
            'required_certifications': feats.get('required_certifications', []),
            'required_clearances': feats.get('required_clearances', []),
            'onsite_required': feats.get('onsite_required'),
            'work_locations': feats.get('work_locations', []),
            'naics_codes': feats.get('naics_codes', []),
            'industry_tags': feats.get('industry_tags', []),
            'min_past_performance': feats.get('min_past_performance', ''),
            'contract_value_estimate': feats.get('contract_value_estimate', ''),
            'timeline_duration': feats.get('timeline_duration', ''),
            'work_description': feats.get('work_description', ''),
            'award_date': dts.get('award_date', ''),
            'start_date': dts.get('start_date', ''),
            'end_date': dts.get('end_date', ''),
        }
        contract_dict = create_contract(request.user.id, metadata, file=data.get('document'))
        if not contract_dict:
            logger.warning(
                "Contract create failed for user_id=%s: create_contract returned None (check AWS credentials, bucket, and server log above)",
                request.user.id,
            )
            return Response(
                {
                    'error': 'Contract storage unavailable',
                    'detail': 'Check AWS credentials and S3 bucket (AWS_STORAGE_BUCKET_NAME) in back_end/.env. See server logs for the exact error.',
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        refresh_profile_from_contracts(request.user)
        obj = contract_dict_to_object(contract_dict)
        return Response(ContractSerializer(obj).data, status=status.HTTP_201_CREATED)


class ContractDetailView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update, or delete a contract. Stored in AWS."""
    serializer_class = ContractSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return []

    def get_object(self):
        pk = self.kwargs.get('pk')
        c = get_contract(self.request.user.id, str(pk))
        if not c:
            from rest_framework.exceptions import NotFound
            raise NotFound()
        return contract_dict_to_object(c)

    def perform_destroy(self, instance):
        user_id = self.request.user.id
        contract_id = getattr(instance, 'id', self.kwargs.get('pk'))
        delete_contract(user_id, str(contract_id))
        refresh_profile_from_contracts(self.request.user)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        contract_id = getattr(instance, 'id', kwargs.get('pk'))
        jur = request.data.get('jurisdiction', {}) if isinstance(request.data, dict) else {}
        feats = request.data.get('features', {}) if isinstance(request.data, dict) else {}
        dts = request.data.get('dates', {}) if isinstance(request.data, dict) else {}
        metadata = {}
        if 'title' in request.data:
            metadata['title'] = request.data.get('title', '')
        if 'rfp_id' in request.data:
            metadata['rfp_id'] = request.data.get('rfp_id', '')
        if 'issuing_agency' in request.data:
            metadata['issuing_agency'] = request.data.get('issuing_agency', '')
        if jur:
            metadata['jurisdiction_state'] = jur.get('state', 'CA')
            metadata['jurisdiction_county'] = jur.get('county', '')
            metadata['jurisdiction_city'] = jur.get('city', '')
        if feats:
            for k in ('required_certifications', 'required_clearances', 'onsite_required', 'work_locations',
                      'naics_codes', 'industry_tags', 'min_past_performance', 'contract_value_estimate',
                      'timeline_duration', 'work_description'):
                if k in feats:
                    metadata[k] = feats[k]
        if dts:
            for k in ('award_date', 'start_date', 'end_date'):
                if k in dts:
                    metadata[k] = dts[k]
        file = request.FILES.get('document') if request.FILES else None
        updated = update_contract(request.user.id, str(contract_id), metadata, file=file)
        if not updated:
            return Response({'error': 'Contract not found'}, status=status.HTTP_404_NOT_FOUND)
        refresh_profile_from_contracts(request.user)
        return Response(ContractSerializer(contract_dict_to_object(updated)).data)


class UserProfileView(generics.RetrieveUpdateAPIView):
    """Get or update current user's profile. Stored in S3 user JSON."""
    serializer_class = UserProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        profile_dict = get_or_create_profile(self.request.user.id)
        return profile_dict_to_object(profile_dict)

    def update(self, request, *args, **kwargs):
        user_id = request.user.id
        profile_dict = get_profile(user_id) or get_or_create_profile(user_id)
        serializer = self.get_serializer(data=request.data, partial=kwargs.get('partial', True))
        serializer.is_valid(raise_exception=True)
        for key, value in serializer.validated_data.items():
            if key in profile_dict:
                profile_dict[key] = value
        profile_dict['user_id'] = user_id
        save_profile(profile_dict)  # writes to S3 users/{username}.json
        logger.info("Profile save: updated user JSON in S3 for user_id=%s", user_id)
        return Response(UserProfileSerializer(profile_dict_to_object(profile_dict)).data)


class UserProfileRefreshView(generics.GenericAPIView):
    """Manually refresh profile from contracts. Stored in S3 user JSON."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        profile_dict = refresh_profile_from_contracts(request.user)
        profile_obj = profile_dict_to_object(profile_dict)
        return Response(
            UserProfileSerializer(profile_obj).data,
            status=status.HTTP_200_OK
        )
