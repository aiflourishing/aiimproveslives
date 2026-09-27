"""JSON records for Impacts of AI systems. Uses only the Python standard library."""

import argparse
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1] / "data"
REQUIRED = {"id", "title", "description", "sources", "submitter_is_contributor", "occurred_by"}
OPTIONAL = {"image"}


def is_url(value, https_only=False):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    try:
        parsed = urlsplit(value)
        schemes = {"https"} if https_only else {"http", "https"}
        return parsed.scheme in schemes and bool(parsed.hostname) and parsed.port != 0
    except ValueError:
        return False


def load_catalog(root=ROOT):
    """Load validated Impacts. Source evidence still requires human review."""
    records, errors = {}, []
    for path in sorted((root / "impacts").glob("*.json")):
        def error(message):
            errors.append(f"{path}: {message}")

        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            error(str(exc))
            continue
        if not isinstance(record, dict):
            error("record must be an object")
            continue
        missing = REQUIRED - record.keys()
        unknown = record.keys() - REQUIRED - OPTIONAL
        if missing:
            error(f"missing fields: {', '.join(sorted(missing))}")
        if unknown:
            error(f"unknown fields: {', '.join(sorted(unknown))}")
        for field, value in record.items():
            if field == "submitter_is_contributor":
                if not isinstance(value, bool):
                    error(f"{field} must be true or false")
            elif field == "sources":
                if not isinstance(value, list) or not value or any(not is_url(url) for url in value):
                    error("sources must be a nonempty list of HTTP(S) URLs")
            elif not isinstance(value, str) or not value.strip():
                error(f"{field} must be a nonempty string")

        occurred_by = record.get("occurred_by")
        try:
            if not isinstance(occurred_by, str) or not re.fullmatch(r"[0-9]{4}/[0-9]{2}/[0-9]{2}", occurred_by):
                raise ValueError
            datetime.strptime(occurred_by, "%Y/%m/%d")
        except ValueError:
            error("occurred_by must be a valid date in YYYY/MM/DD format")
        if "image" in record and not is_url(record["image"], https_only=True):
            error("image must be a direct HTTPS image URL")
        identifier = record.get("id")
        if not isinstance(identifier, str):
            continue
        try:
            if str(uuid.UUID(identifier)) != identifier:
                raise ValueError
        except ValueError:
            error("Impact id must be a canonical UUID; use new-impact")
        if identifier != path.stem:
            error("id must match the filename")
        if identifier in records:
            error("duplicate id")
        records[identifier] = record
    if errors:
        raise ValueError("\n".join(errors))
    return {"impacts": records}


def new_impact(root=ROOT):
    identifier = str(uuid.uuid4())
    record = {
        "id": identifier,
        "title": "",
        "description": "",
        "occurred_by": "",
        "sources": [],
        "submitter_is_contributor": None,
    }
    path = root / "impacts" / f"{identifier}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate", help="validate Impact records")
    commands.add_parser("new-impact", help="generate an Impact file to fill in")
    args = parser.parse_args()
    if args.command == "new-impact":
        print(new_impact())
    else:
        try:
            catalog = load_catalog()
        except ValueError as exc:
            parser.exit(1, f"{exc}\n")
        print(f"Valid: {len(catalog['impacts'])} Impacts")


if __name__ == "__main__":
    main()
