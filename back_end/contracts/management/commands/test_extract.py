import json
from pathlib import Path

from django.core.management.base import BaseCommand

from contracts.services import extract_metadata_from_document, ExtractionError


class Command(BaseCommand):
    help = "Test contract metadata extraction on a PDF file"

    def add_arguments(self, parser):
        parser.add_argument(
            "file",
            type=str,
            help="Path to the PDF file to extract from",
        )

    def handle(self, *args, **options):
        file_path = Path(options["file"])
        if not file_path.exists():
            self.stderr.write(self.style.ERROR(f"File not found: {file_path}"))
            return

        if file_path.suffix.lower() != ".pdf":
            self.stderr.write(
                self.style.WARNING("Only PDF is supported. Proceeding anyway...")
            )

        self.stdout.write(f"Extracting from: {file_path}\n")

        try:
            with open(file_path, "rb") as f:
                result = extract_metadata_from_document(f)
            self.stdout.write(self.style.SUCCESS("Extraction successful!\n"))
            self.stdout.write(json.dumps(result, indent=2))
        except ExtractionError as e:
            self.stderr.write(self.style.ERROR(f"Extraction failed: {e}"))
