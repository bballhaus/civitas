from django.conf import settings
from django.db import models


class Contract(models.Model):
    """User-uploaded contract with structured metadata."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='contracts'
    )
    title = models.CharField(max_length=255, blank=True)
    document = models.FileField(upload_to='contracts/%Y/%m/', blank=True, null=True)

    # Core fields
    rfp_id = models.CharField(max_length=255, null=True, blank=True)
    issuing_agency = models.CharField(max_length=255)
    jurisdiction_state = models.CharField(max_length=2, default='CA')
    jurisdiction_county = models.CharField(max_length=255, null=True, blank=True)
    jurisdiction_city = models.CharField(max_length=255, null=True, blank=True)

    # Features (structured metadata)
    required_certifications = models.JSONField(default=list, blank=True)  # ["string"]
    required_clearances = models.JSONField(default=list, blank=True)     # ["string"]
    onsite_required = models.BooleanField(null=True, blank=True)
    work_locations = models.JSONField(default=list, blank=True)          # ["string"]
    naics_codes = models.JSONField(default=list, blank=True)             # ["string"]
    industry_tags = models.JSONField(default=list, blank=True)           # ["string"]
    min_past_performance = models.CharField(max_length=255, null=True, blank=True)
    contract_value_estimate = models.CharField(max_length=255, null=True, blank=True)
    timeline_duration = models.CharField(max_length=255, null=True, blank=True)
    work_description = models.TextField(null=True, blank=True)

    # Dates (stored as ISO strings for flexibility; e.g. "2020-01-15")
    award_date = models.CharField(max_length=50, null=True, blank=True)
    start_date = models.CharField(max_length=50, null=True, blank=True)
    end_date = models.CharField(max_length=50, null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title or f"Contract {self.id} ({self.issuing_agency})"


class UserProfile(models.Model):
    """User background aggregated from past contracts (certifications, total pay, etc.)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='profile'
    )
    name = models.CharField(
        max_length=255, blank=True,
        help_text="Company or business name"
    )
    # Total value from past contracts (numeric for calculations; store as string for display flexibility)
    total_contract_value = models.DecimalField(
        max_digits=14, decimal_places=2, default=0, blank=True
    )
    contract_count = models.PositiveIntegerField(default=0, blank=True)
    # Aggregated sets from contracts (deduplicated)
    certifications = models.JSONField(default=list, blank=True)  # ["string"]
    clearances = models.JSONField(default=list, blank=True)     # ["string"]
    naics_codes = models.JSONField(default=list, blank=True)   # ["string"]
    industry_tags = models.JSONField(default=list, blank=True) # ["string"]
    work_cities = models.JSONField(default=list, blank=True)   # ["string"]
    work_counties = models.JSONField(default=list, blank=True) # ["string"]
    capabilities = models.JSONField(
        default=list, blank=True,
        help_text="Services and expertise your company provides"
    )
    agency_experience = models.JSONField(
        default=list, blank=True,
        help_text="Agencies worked for (from past contracts)"
    )
    size_status = models.JSONField(default=list, blank=True)
    contract_types = models.JSONField(default=list, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)