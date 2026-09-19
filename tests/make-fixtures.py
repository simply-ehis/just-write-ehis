"""Generate tiny binary book fixtures for the e2e parsing checks.

Outputs (committed, all hand-built, public-domain text):
  tests/fixtures/sample.epub  — one chapter, h1 + two paragraphs
  tests/fixtures/sample.docx  — heading + paragraph via raw OOXML
  tests/fixtures/sample.pdf   — one page, Helvetica, computed xref
All three contain the marker sentence about the quick brown fox.
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
os.makedirs(FIX, exist_ok=True)

MARKER = "The quick brown fox jumps over the lazy dog."

# --- EPUB ---------------------------------------------------------------
with zipfile.ZipFile(os.path.join(FIX, "sample.epub"), "w") as z:
    z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr(
        "META-INF/container.xml",
        '<?xml version="1.0"?>'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>',
    )
    z.writestr(
        "OEBPS/content.opf",
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">'
        "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
        "<dc:title>Fixture Tales</dc:title></metadata>"
        "<manifest>"
        '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
        "</manifest><spine><itemref idref=\"ch1\"/></spine></package>",
    )
    z.writestr(
        "OEBPS/ch1.xhtml",
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>'
        f"<body><h1>Chapter One</h1><p>{MARKER}</p><p>Second paragraph.</p></body></html>",
    )

# --- DOCX (raw OOXML, no generator dependency) ---------------------------
with zipfile.ZipFile(os.path.join(FIX, "sample.docx"), "w") as z:
    z.writestr(
        "[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>",
    )
    z.writestr(
        "_rels/.rels",
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>",
    )
    z.writestr(
        "word/document.xml",
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        "<w:r><w:t>Chapter One</w:t></w:r></w:p>"
        f"<w:p><w:r><w:t>{MARKER}</w:t></w:r></w:p>"
        "</w:body></w:document>",
    )

# --- PDF (hand-built, offsets computed) ----------------------------------


def pdf_obj(n: int, body: bytes) -> bytes:
    return ("%d 0 obj\n" % n).encode() + body + b"\nendobj\n"


stream = (
    b"BT /F1 24 Tf 72 720 Td (Chapter One) Tj ET\n"
    b"BT /F1 12 Tf 72 690 Td (" + MARKER.encode() + b") Tj ET\n"
)
objs = [
    pdf_obj(1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    pdf_obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    pdf_obj(
        3,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    pdf_obj(4, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    pdf_obj(5, b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream"),
]

out = bytearray(b"%PDF-1.4\n")
offsets = []
for obj in objs:
    offsets.append(len(out))
    out += obj
xref_at = len(out)
out += ("xref\n0 6\n0000000000 65535 f \n").encode()
for off in offsets:
    out += ("%010d 00000 n \n" % off).encode()
out += (
    b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"
    + str(xref_at).encode()
    + b"\n%%EOF"
)
with open(os.path.join(FIX, "sample.pdf"), "wb") as f:
    f.write(bytes(out))

print("fixtures written to", FIX)
