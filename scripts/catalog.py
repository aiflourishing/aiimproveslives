"""JSON records for Profiles and Impacts. Uses only the Python standard library."""

import argparse
import json
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1] / "data"
TYPES = {"research", "model", "system", "product", "dataset"}
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
REQUIRED = {
    "profiles": {"id", "name", "types", "description", "url", "submitter_is_contributor"},
    "impacts": {"id", "profile_id", "title", "description", "sources", "submitter_is_contributor"},
}
OPTIONAL = {"profiles": {"sources", "contributors", "image"}, "impacts": {"contributors", "cites", "image"}}


def is_url(value, https_only=False):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    try:
        parsed = urlsplit(value)
        schemes = {"https"} if https_only else {"http", "https"}
        return parsed.scheme in schemes and bool(parsed.hostname) and parsed.port != 0
    except ValueError:
        return False


def names(value):
    """Parse intake names without removing spaces within a name."""
    return [name.strip() for name in value.split(",") if name.strip()]


def load_catalog(root=ROOT):
    """Return accepted-format records, or raise ValueError with validation errors.

    Profiles' Impacts are derived by matching profile_id; no reverse list is stored.
    Source evidence and acceptance still require human review.
    """
    catalog = {"profiles": {}, "impacts": {}}
    errors = []
    for kind, records in catalog.items():
        for path in sorted((root / kind).glob("*.json")):
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
            missing = REQUIRED[kind] - record.keys()
            unknown = record.keys() - REQUIRED[kind] - OPTIONAL[kind]
            if missing:
                error(f"missing fields: {', '.join(sorted(missing))}")
            if unknown:
                error(f"unknown fields: {', '.join(sorted(unknown))}")
            list_fields = {"types", "sources", "contributors", "cites"}
            for field, value in record.items():
                if field == "submitter_is_contributor":
                    if not isinstance(value, bool):
                        error(f"{field} must be true or false")
                elif field in list_fields:
                    if not isinstance(value, list) or any(
                        not isinstance(item, str) or not item.strip() for item in value
                    ):
                        error(f"{field} must be a list of nonempty strings")
                    elif field in {"types", "sources"} and not value:
                        error(f"{field} must not be empty")
                elif not isinstance(value, str) or not value.strip():
                    error(f"{field} must be a nonempty string")

            identifier = record.get("id")
            if not isinstance(identifier, str) or not identifier:
                continue
            if identifier != path.stem:
                error("id must match the filename")
            if identifier in records:
                error("duplicate id")
            if kind == "profiles":
                if not SLUG.fullmatch(identifier):
                    error("Profile id must be lowercase words separated by hyphens")
                types = record.get("types", [])
                if isinstance(types, list) and any(
                    not isinstance(item, str) or item not in TYPES for item in types
                ):
                    error(f"types must be chosen from: {', '.join(sorted(TYPES))}")
                if not is_url(record.get("url")):
                    error("url must be an HTTP(S) URL")
            else:
                try:
                    if str(uuid.UUID(identifier)) != identifier:
                        raise ValueError
                except ValueError:
                    error("Impact id must be a canonical UUID; use new-impact")
            sources = record.get("sources", [])
            if isinstance(sources, list) and any(not is_url(url) for url in sources):
                error("sources must contain HTTP(S) URLs")
            if "image" in record and not is_url(record["image"], https_only=True):
                error("image must be a direct HTTPS image URL")
            records[identifier] = record

    for identifier, impact in catalog["impacts"].items():
        references = [("profile_id", impact.get("profile_id"))]
        cites = impact.get("cites", [])
        if isinstance(cites, list):
            references.extend(("cites", cite) for cite in cites
                              if isinstance(cite, str) and cite.startswith("@"))
        for field, ref in references:
            if not isinstance(ref, str) or not ref.startswith("@") or ref[1:] not in catalog["profiles"]:
                errors.append(f"Impact {identifier}: {field} must reference an existing @profile-id")
    if errors:
        raise ValueError("\n".join(errors))
    return catalog


def new_impact(root, profile, contributors=""):
    identifier = str(uuid.uuid4())
    record = {
        "id": identifier,
        "profile_id": profile if profile.startswith("@") else f"@{profile}",
        "title": "",
        "description": "",
        "sources": [],
        "submitter_is_contributor": None,
    }
    if contributors:
        record["contributors"] = names(contributors)
    path = root / "impacts" / f"{identifier}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate", help="validate records and Profile references")
    create = commands.add_parser("new-impact", help="generate an Impact file to fill in")
    create.add_argument("profile", help="Profile id, with or without @")
    create.add_argument("--contributors", default="", help="comma-separated names")
    args = parser.parse_args()
    if args.command == "new-impact":
        print(new_impact(ROOT, args.profile, args.contributors))
    else:
        try:
            catalog = load_catalog()
        except ValueError as exc:
            parser.exit(1, f"{exc}\n")
        print(f"Valid: {len(catalog['profiles'])} Profiles, {len(catalog['impacts'])} Impacts")


if __name__ == "__main__":
    main()
