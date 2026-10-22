# Test fixtures

Everything here is synthetic and exists only for automated tests.

- `test-signer.p12`, `test-ca-signer-*.p12` (password `opendraft-test`) and `test-ca.key` are **test-only** keys for
  certificates whose subject says "OpenDraft test fixture (not a real identity)". They are not secret, must never be
  trusted outside tests, and grant nothing.
- `test-ca.pem`, `test-ca.crl` and `test-ca-index.txt` form a tiny certificate authority: serial 0x1001 is valid,
  serial 0x1002 is revoked. Its certificates name `http://127.0.0.1:4199/` as their OCSP responder, which the tests
  start locally with `openssl ocsp`.
- `scanned-plan*.png`, `red-blue-64.jp2` and `estimate.xlsx` are generated drawings, images and workbooks.
