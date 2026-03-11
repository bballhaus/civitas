"""
Management command to delete all non-superuser accounts and their S3 data.

Usage:
    python manage.py cleanup_users          # dry-run (default)
    python manage.py cleanup_users --apply  # actually delete
"""
import logging

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from contracts.services.user_data_s3 import (
    get_token_index,
    get_user_data,
    save_token_index,
    save_user_data,
)

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Delete all non-superuser accounts and their S3 user data (profiles, tokens, RFP status)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply",
            action="store_true",
            default=False,
            help="Actually delete accounts. Without this flag, the command only shows what would be deleted (dry-run).",
        )
        parser.add_argument(
            "--include-staff",
            action="store_true",
            default=False,
            help="Also delete staff accounts (but never superusers).",
        )

    def handle(self, *args, **options):
        apply = options["apply"]
        include_staff = options["include_staff"]
        User = get_user_model()

        users_qs = User.objects.filter(is_superuser=False)
        if not include_staff:
            users_qs = users_qs.filter(is_staff=False)

        users = list(users_qs.values_list("id", "username", "email"))
        if not users:
            self.stdout.write(self.style.SUCCESS("No accounts to delete."))
            return

        mode = "APPLYING" if apply else "DRY-RUN"
        self.stdout.write(self.style.WARNING(f"[{mode}] Found {len(users)} account(s) to delete:\n"))
        for uid, uname, email in users:
            self.stdout.write(f"  id={uid}  username={uname}  email={email}")

        if not apply:
            self.stdout.write(self.style.NOTICE(
                "\nThis is a dry-run. Re-run with --apply to actually delete these accounts."
            ))
            return

        # Load token index once, remove entries as we go, then save once
        token_index = get_token_index()
        tokens_to_remove = []

        deleted_count = 0
        for uid, username, email in users:
            # 1. Delete S3 user data by writing an empty object (S3 doesn't have a simple delete via our helpers)
            s3_data = get_user_data(username)
            if s3_data is not None:
                # Find and remove token from index
                user_token = s3_data.get("token")
                if user_token and user_token in token_index:
                    tokens_to_remove.append(user_token)
                # Overwrite with empty object to clear the S3 file
                save_user_data(username, {})
                self.stdout.write(f"  Cleared S3 data for {username}")

            # 2. Delete Django user
            try:
                user_obj = User.objects.get(pk=uid)
                user_obj.delete()
                deleted_count += 1
                self.stdout.write(f"  Deleted Django user {username} (id={uid})")
            except User.DoesNotExist:
                self.stdout.write(self.style.WARNING(f"  User {username} (id={uid}) already gone"))

        # 3. Clean up token index
        for token in tokens_to_remove:
            token_index.pop(token, None)
        save_token_index(token_index)

        self.stdout.write(self.style.SUCCESS(
            f"\nDone. Deleted {deleted_count} account(s), removed {len(tokens_to_remove)} token(s) from index."
        ))
