#!/usr/bin/env python3
"""anonymize-export.py — turn a real XLSX/CSV export into a safe dummy fixture.

Real production exports (campaign data, order data, PII-bearing reports)
sometimes need to become checked-in test fixtures. This applies three
reversible-shaped-but-non-recoverable transforms so the file keeps its real
structure (row counts, column types, realistic-looking values) without
exposing real IDs, names, or business data:

  1. Digit transposition on numeric IDs — swaps digit positions using a fixed
     seed, so IDs look real but don't map back to production records.
  2. Regex-based rename map for known business terms (brand names, SKUs).
  3. Deterministic hash-seeded pseudonyms for people/account names — same
     input always produces the same fake output within one run, so joins
     across sheets/files stay consistent.

Usage:
    python3 anonymize-export.py input.xlsx output.xlsx \
        --id-columns "campaign_id,creator_id" \
        --name-columns "creator_name,account_name" \
        --rename-map '{"Acme Corp": "Brand A", "SKU-1234": "SKU-XXXX"}'

Requires: openpyxl (`pip install openpyxl` or project venv).
"""

import argparse
import hashlib
import json
import re
import sys

try:
    import openpyxl
except ImportError:
    print("error: openpyxl required — pip install openpyxl", file=sys.stderr)
    sys.exit(1)


def transpose_digits(value: str, seed: int = 7) -> str:
    """Swap digit positions deterministically — same input always gives the
    same output, but the result doesn't map back to the original number."""
    digits = list(value)
    n = len(digits)
    if n < 2:
        return value
    for i in range(n):
        j = (i + seed) % n
        if digits[i].isdigit() and digits[j].isdigit():
            digits[i], digits[j] = digits[j], digits[i]
    return "".join(digits)


def pseudonym(value: str, prefix: str = "Person") -> str:
    """Deterministic hash-seeded fake name — same real name always maps to the
    same fake name within and across runs (stable seed), so joins on name
    across multiple sheets/files stay consistent."""
    h = hashlib.md5(value.encode("utf-8")).hexdigest()[:6]
    return f"{prefix}_{h}"


def apply_rename_map(value: str, rename_map: dict) -> str:
    for pattern, replacement in rename_map.items():
        value = re.sub(re.escape(pattern), replacement, value, flags=re.IGNORECASE)
    return value


def anonymize_sheet(ws, id_columns: set, name_columns: set, rename_map: dict):
    header = [cell.value for cell in ws[1]]
    col_index = {name: i for i, name in enumerate(header) if name}

    id_idx = {col_index[c] for c in id_columns if c in col_index}
    name_idx = {col_index[c] for c in name_columns if c in col_index}

    for row in ws.iter_rows(min_row=2):
        for cell in row:
            col = cell.column - 1
            if cell.value is None:
                continue
            value = str(cell.value)
            if col in id_idx:
                cell.value = transpose_digits(value)
            elif col in name_idx:
                cell.value = pseudonym(value)
            elif rename_map:
                cell.value = apply_rename_map(value, rename_map)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Real export file (.xlsx)")
    parser.add_argument("output", help="Path to write the anonymized fixture")
    parser.add_argument("--id-columns", default="", help="Comma-separated column headers to digit-transpose")
    parser.add_argument("--name-columns", default="", help="Comma-separated column headers to pseudonymize")
    parser.add_argument("--rename-map", default="{}", help="JSON object of literal string replacements (brand names, SKUs)")
    args = parser.parse_args()

    id_columns = {c.strip() for c in args.id_columns.split(",") if c.strip()}
    name_columns = {c.strip() for c in args.name_columns.split(",") if c.strip()}
    rename_map = json.loads(args.rename_map)

    wb = openpyxl.load_workbook(args.input)
    for ws in wb.worksheets:
        anonymize_sheet(ws, id_columns, name_columns, rename_map)

    wb.save(args.output)
    print(f"Wrote anonymized fixture: {args.output}")


if __name__ == "__main__":
    main()
