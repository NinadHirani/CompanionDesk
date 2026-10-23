#!/usr/bin/env python3
"""Regenerate tests/fixtures/syllabus-sample.pdf (a minimal, hand-built PDF
with no dependencies, so the fixture is reproducible from source)."""
import os

LINES = [
    "GTU CS-402: Quantum Computing - Fall 2026 Syllabus",
    "Instructor: Dr. R. Shah  |  Credits: 3",
    "Grading: Midterm 30%, Final 40%, Problem Sets 30%",
    "",
    "Course schedule (all dates Fall 2026):",
    "  Aug 12 - Problem Set 1 due",
    "  Sep 9 - Problem Set 2 due",
    "  Oct 7 - Midterm exam",
    "  Nov 11 - Final project presentation",
    "  Dec 2 - Final exam",
    "  TBA - Guest lecture on quantum networking",
    "",
    "Note: dates follow the GTU academic calendar; verify each against the LMS.",
]

def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

content = "BT /F1 12 Tf 72 740 Td 16 TL\n"
content += "".join(f"({esc(line)}) Tj T*\n" for line in LINES)
content += "ET"

stream = content.encode("latin-1")
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
]

out = bytearray(b"%PDF-1.4\n")
offsets = []
for i, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref_at = len(out)
out += b"xref\n0 %d\n" % (len(objects) + 1)
out += b"0000000000 65535 f \n"
for off in offsets:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref_at)

dest = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "syllabus-sample.pdf")
with open(os.path.abspath(dest), "wb") as f:
    f.write(bytes(out))
print("wrote", os.path.abspath(dest), len(out), "bytes")
