from rest_framework import serializers
from .models import Contract, UserProfile
from .services import extract_metadata_from_document, ExtractionError


class ContractSerializer(serializers.ModelSerializer):
    jurisdiction = serializers.SerializerMethodField()
    features = serializers.SerializerMethodField()

    class Meta:
        model = Contract
        fields = [
            'id',
            'title',
            'document',
            'issuing_agency',
            'jurisdiction',
            'features',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at']
        extra_kwargs = {
            'issuing_agency': {'required': False},
        }

    def get_jurisdiction(self, obj):
        return {
            'state': obj.jurisdiction_state,
            'county': obj.jurisdiction_county,
            'city': obj.jurisdiction_city,
        }

    def get_features(self, obj):
        return {
            'required_certifications': obj.required_certifications or [],
            'required_clearances': obj.required_clearances or [],
            'onsite_required': obj.onsite_required,
            'work_locations': obj.work_locations or [],
            'naics_codes': obj.naics_codes or [],
            'industry_tags': obj.industry_tags or [],
            'min_past_performance': obj.min_past_performance,
            'contract_value_estimate': obj.contract_value_estimate,
            'timeline_duration': obj.timeline_duration,
        }

    def create(self, validated_data):
        jurisdiction = self.initial_data.get('jurisdiction') or {}
        features = self.initial_data.get('features') or {}

        # Run LLM extraction if document uploaded and extract=true
        extract = self.initial_data.get('extract')
        if extract in (True, 'true', '1') and validated_data.get('document'):
            try:
                extracted = extract_metadata_from_document(validated_data['document'])
                # Merge: user-provided values override extracted
                jurisdiction = {**extracted.get('jurisdiction', {}), **jurisdiction}
                features = {**extracted.get('features', {}), **features}
                if not validated_data.get('issuing_agency'):
                    validated_data['issuing_agency'] = extracted.get('issuing_agency', 'Unknown')
                if not validated_data.get('title') and extracted.get('title'):
                    validated_data['title'] = extracted['title']
            except ExtractionError as e:
                raise serializers.ValidationError({'document': str(e)})

        if not validated_data.get('issuing_agency'):
            validated_data['issuing_agency'] = 'Unknown'

        validated_data['jurisdiction_state'] = jurisdiction.get(
            'state', validated_data.get('jurisdiction_state', 'CA')
        )
        validated_data['jurisdiction_county'] = jurisdiction.get('county')
        validated_data['jurisdiction_city'] = jurisdiction.get('city')
        validated_data['required_certifications'] = features.get(
            'required_certifications', []
        )
        validated_data['required_clearances'] = features.get(
            'required_clearances', []
        )
        validated_data['onsite_required'] = features.get('onsite_required')
        validated_data['work_locations'] = features.get('work_locations', [])
        validated_data['naics_codes'] = features.get('naics_codes', [])
        validated_data['industry_tags'] = features.get('industry_tags', [])
        validated_data['min_past_performance'] = features.get(
            'min_past_performance'
        )
        validated_data['contract_value_estimate'] = features.get(
            'contract_value_estimate'
        )
        validated_data['timeline_duration'] = features.get('timeline_duration')

        validated_data['user'] = self.context['request'].user
        instance = super().create(validated_data)
        profile, _ = UserProfile.objects.get_or_create(user=instance.user)
        profile.refresh_from_contracts()
        return instance

    def update(self, instance, validated_data):
        jurisdiction = self.initial_data.get('jurisdiction')
        features = self.initial_data.get('features')

        if jurisdiction:
            instance.jurisdiction_state = jurisdiction.get(
                'state', instance.jurisdiction_state
            )
            instance.jurisdiction_county = jurisdiction.get('county')
            instance.jurisdiction_city = jurisdiction.get('city')
        if features:
            if 'required_certifications' in features:
                instance.required_certifications = features['required_certifications']
            if 'required_clearances' in features:
                instance.required_clearances = features['required_clearances']
            if 'onsite_required' in features:
                instance.onsite_required = features['onsite_required']
            if 'work_locations' in features:
                instance.work_locations = features['work_locations']
            if 'naics_codes' in features:
                instance.naics_codes = features['naics_codes']
            if 'industry_tags' in features:
                instance.industry_tags = features['industry_tags']
            if 'min_past_performance' in features:
                instance.min_past_performance = features['min_past_performance']
            if 'contract_value_estimate' in features:
                instance.contract_value_estimate = features[
                    'contract_value_estimate'
                ]
            if 'timeline_duration' in features:
                instance.timeline_duration = features['timeline_duration']

        for attr, value in validated_data.items():
            if attr not in ('jurisdiction', 'features'):
                setattr(instance, attr, value)
        instance.save()
        profile, _ = UserProfile.objects.get_or_create(user=instance.user)
        profile.refresh_from_contracts()
        return instance


class UserProfileSerializer(serializers.ModelSerializer):
    total_past_contract_value = serializers.DecimalField(
        source='total_contract_value',
        max_digits=14,
        decimal_places=2,
        read_only=True
    )

    class Meta:
        model = UserProfile
        fields = [
            'id',
            'total_past_contract_value',
            'certifications',
            'clearances',
            'naics_codes',
            'industry_tags',
            'work_locations',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'total_past_contract_value', 'certifications', 'clearances',
            'naics_codes', 'industry_tags', 'work_locations',
            'created_at', 'updated_at',
        ]
