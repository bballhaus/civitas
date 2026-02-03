from django.urls import path
from . import views

urlpatterns = [
    path('contracts/extract/', views.ContractExtractView.as_view(), name='contract-extract'),
    path('contracts/', views.ContractListCreateView.as_view(), name='contract-list-create'),
    path('contracts/<int:pk>/', views.ContractDetailView.as_view(), name='contract-detail'),
    path('profile/', views.UserProfileView.as_view(), name='profile'),
    path('profile/refresh/', views.UserProfileRefreshView.as_view(), name='profile-refresh'),
]
