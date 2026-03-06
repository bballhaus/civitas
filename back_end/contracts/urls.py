from django.urls import path
from . import views

urlpatterns = [
    path('auth/csrf/', views.CsrfView.as_view(), name='csrf'),
    path('auth/signup/', views.SignupView.as_view(), name='signup'),
    path('auth/login/', views.LoginView.as_view(), name='login'),
    path('auth/logout/', views.LogoutView.as_view(), name='logout'),
    path('auth/me/', views.CurrentUserView.as_view(), name='current-user'),
    path('user/rfp-status/', views.UserRfpStatusView.as_view(), name='user-rfp-status'),
    path('user/generated-poe/', views.UserGeneratedPoeView.as_view(), name='user-generated-poe'),
    path('contracts/extract/', views.ContractExtractView.as_view(), name='contract-extract'),
    path('profile/extract/', views.ProfileExtractView.as_view(), name='profile-extract'),
    path('contracts/', views.ContractListCreateView.as_view(), name='contract-list-create'),
    path('contracts/<str:pk>/', views.ContractDetailView.as_view(), name='contract-detail'),
    path('profile/', views.UserProfileView.as_view(), name='profile'),
    path('profile/refresh/', views.UserProfileRefreshView.as_view(), name='profile-refresh'),
]
