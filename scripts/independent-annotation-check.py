"""Independent PDFium annotation-vs-flatten appearance regression (synthetic only).

Generate: node scripts/generate-annotation-validation.mjs
Install pypdfium2==5.14.0 in a separate validation environment, then run:
python scripts/independent-annotation-check.py test-results/annotation-validation
No production dependency, upload, GUI, or inference service is used.
"""
import json
import hashlib
from importlib.metadata import version
from pathlib import Path
import sys
import pypdfium2 as pdfium
import pypdfium2.raw as raw

folder = Path(sys.argv[1] if len(sys.argv) > 1 else "test-results/annotation-validation")
manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
package_version = version("pypdfium2")
assert package_version == "5.14.0", "Use the documented validation package version."
(folder / "pdfium-results.json").write_text(json.dumps({"passed": False, "status": "in-progress", "renderer": f"PDFium via pypdfium2 {package_version}"}) + "\n", encoding="utf-8")
results = []

def rendered(page, annotations):
    bitmap = page.render(scale=manifest["renderScale"], draw_annots=annotations)
    try:
        return bitmap.width, bitmap.height, bytes(bitmap.buffer)
    finally:
        bitmap.close()

with pdfium.PdfDocument(folder / "baseline.pdf") as baseline, pdfium.PdfDocument(folder / "annotated.pdf") as annotated, pdfium.PdfDocument(folder / "flattened.pdf") as flattened:
    assert len(baseline) == len(annotated) == len(flattened) == manifest["pageCount"]
    for index in range(len(baseline)):
        original, edited, flat = baseline[index], annotated[index], flattened[index]
        try:
            assert raw.FPDFPage_GetAnnotCount(edited) == manifest["expectedAnnotationCounts"][index]
            assert raw.FPDFPage_GetAnnotCount(flat) == 0
            width, height, source = rendered(original, False)
            ew, eh, annotations_hidden = rendered(edited, False)
            assert (width, height) == (ew, eh)
            assert source == annotations_hidden, f"Baseline page content changed on page {index + 1}"
            aw, ah, shown = rendered(edited, True)
            fw, fh, baked = rendered(flat, True)
            assert (aw, ah) == (fw, fh) == (width, height)
            assert len(shown) == len(baked) == len(source)
            changed_from_source = sum(a != b for a, b in zip(shown, source))
            assert changed_from_source > 20, f"Annotation appearance missing on page {index + 1}"
            differences = [abs(a - b) for a, b in zip(shown, baked)]
            mean = sum(differences) / len(differences)
            fraction = sum(value != 0 for value in differences) / len(differences)
            result = {"page": index + 1, "kind": manifest["pageKinds"][index], "width": width, "height": height, "meanChannelDifference": mean, "changedChannelFraction": fraction, "maxChannelDifference": max(differences), "channelsChangedFromBaseline": changed_from_source}
            results.append(result)
            print(json.dumps(result))
            assert mean <= manifest["tolerance"]["meanChannelDifference"], f"Mean appearance difference exceeded on page {index + 1}"
            assert fraction <= manifest["tolerance"]["changedChannelFraction"], f"Changed-channel fraction exceeded on page {index + 1}"
        finally:
            original.close()
            edited.close()
            flat.close()

hashes = {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in ["baseline.pdf", "annotated.pdf", "flattened.pdf"]}
report = {"renderer": f"PDFium via pypdfium2 {package_version}", "fixture": manifest["fixture"], "sha256": hashes, "scale": manifest["renderScale"], "tolerance": manifest["tolerance"], "passed": True, "pages": results, "limitations": manifest["limitations"]}
(folder / "pdfium-results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(f"Independent PDFium annotation/flatten regression passed for all {manifest['pageCount']} synthetic pages")
