"""Optional independent parser check: install pypdf separately, pass exported fixture path."""
import sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
assert len(reader.pages) == 2
assert [p.rotation for p in reader.pages] == [90, 90]
assert "OpenDraft synthetic drawing A101" in reader.pages[0].extract_text()
assert "Valve schedule" in reader.pages[1].extract_text()
print("pypdf independent validation passed: 2 pages, rotations [90, 90], both known text strings retained")
