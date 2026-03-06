import re

from django.core.exceptions import ValidationError


class UppercaseValidator:
    def validate(self, password, user=None):
        if not re.search(r"[A-Z]", password):
            raise ValidationError(
                "Password must contain at least one uppercase letter.",
                code="password_no_upper",
            )

    def get_help_text(self):
        return "Your password must contain at least one uppercase letter."


class LowercaseValidator:
    def validate(self, password, user=None):
        if not re.search(r"[a-z]", password):
            raise ValidationError(
                "Password must contain at least one lowercase letter.",
                code="password_no_lower",
            )

    def get_help_text(self):
        return "Your password must contain at least one lowercase letter."


class SpecialCharacterValidator:
    def validate(self, password, user=None):
        if not re.search(r"[^A-Za-z0-9]", password):
            raise ValidationError(
                "Password must contain at least one special character.",
                code="password_no_special",
            )

    def get_help_text(self):
        return "Your password must contain at least one special character (e.g. !@#$%^&*)."
