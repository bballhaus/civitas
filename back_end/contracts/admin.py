from django.contrib import admin
from .models import Contract, UserProfile


@admin.register(Contract)
class ContractAdmin(admin.ModelAdmin):
    list_display = ['id', 'title', 'rfp_id', 'user', 'issuing_agency', 'jurisdiction_state', 'created_at']
    list_filter = ['jurisdiction_state', 'created_at']
    search_fields = ['title', 'rfp_id', 'issuing_agency', 'user__username']


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ['id', 'user', 'name', 'contract_count', 'total_contract_value', 'created_at']
    search_fields = ['user__username']
