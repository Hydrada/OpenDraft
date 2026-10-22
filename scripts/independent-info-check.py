"""Compare PDF Info dictionaries with pypdf; validation dependency is not shipped."""
import sys
from pypdf import PdfReader

if len(sys.argv) < 3:
    raise SystemExit('Usage: python independent-info-check.py SOURCE.pdf OUTPUT.pdf [OUTPUT.pdf ...]')
source = PdfReader(sys.argv[1]).metadata
expected = dict(source) if source is not None else None
for filename in sys.argv[2:]:
    info = PdfReader(filename).metadata
    actual = dict(info) if info is not None else None
    if actual != expected:
        raise SystemExit(f'PDF Info differs: {filename}')
print(f'Independent PDF Info check: {len(sys.argv)-2} export(s) match the source.')
