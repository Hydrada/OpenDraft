"""Optional independent PDFium visual regression on the synthetic organization fixture.

Install pypdfium2==5.14.0 in a separate validation environment. Arguments: source.pdf output.pdf.
Expected output is source page 2 rotated -90, then source page 1 rotated +90.
This is a two-page fixture regression, not broad PDF interoperability certification.
"""
import sys
import pypdfium2 as pdfium

with pdfium.PdfDocument(sys.argv[1]) as source, pdfium.PdfDocument(sys.argv[2]) as output:
    assert len(output) == 2
    for index, (source_index, delta) in enumerate([(1, 270), (0, 90)]):
        original = source[source_index]
        edited = output[index]
        expected = original.render(scale=1, rotation=delta)
        actual = edited.render(scale=1)
        try:
            assert (expected.width, expected.height) == (actual.width, actual.height)
            expected_bytes = bytes(expected.buffer)
            actual_bytes = bytes(actual.buffer)
            assert expected_bytes == actual_bytes, f"Visual pixels differ on output page {index + 1}"
            print(f"PDFium output page {index + 1}: {actual.width}x{actual.height}, exact reference pixel match")
        finally:
            expected.close()
            actual.close()
            original.close()
            edited.close()
print("Independent PDFium visual regression passed for both synthetic pages")
