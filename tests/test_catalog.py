import json
import tempfile
import unittest
from pathlib import Path

from scripts.catalog import load_catalog, new_impact


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.impact_path = new_impact(self.root)
        self.impact = json.loads(self.impact_path.read_text())
        self.impact.update(title="Sample benefit", description="An observed benefit.",
                           occurred_by="2026/09/13",
                           submitter_is_contributor=True,
                           sources=["https://example.org/evidence"])
        self.write(self.impact_path, self.impact)

    def write(self, path, record):
        path.write_text(json.dumps(record), encoding="utf-8")

    def test_loads_impacts_without_profiles(self):
        self.assertEqual(load_catalog(self.root), {"impacts": {self.impact["id"]: self.impact}})

    def test_generated_ids_are_distinct_and_existing_file_is_unchanged(self):
        original = self.impact_path.read_bytes()
        second = new_impact(self.root)
        self.assertNotEqual(second.stem, self.impact_path.stem)
        self.assertEqual(self.impact_path.read_bytes(), original)

    def test_rejects_removed_fields(self):
        for field in ["profile_id", "types", "contributors", "cites"]:
            self.write(self.impact_path, {**self.impact, field: "obsolete"})
            with self.assertRaisesRegex(ValueError, "unknown fields"):
                load_catalog(self.root)

    def test_rejects_malformed_impact_fields(self):
        cases = {"sources": [[], ["not a url"], "https://example.org", [None]],
                 "title": ["", "   ", 1],
                 "image": ["http://example.org/image.jpg", "https://", "https://example.org:bad/a"]}
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.write(self.impact_path, {**self.impact, field: value})
                    with self.assertRaises(ValueError):
                        load_catalog(self.root)

    def test_rejects_missing_and_unknown_fields(self):
        del self.impact["description"]
        self.impact["unexpected"] = "value"
        self.write(self.impact_path, self.impact)
        with self.assertRaises(ValueError) as caught:
            load_catalog(self.root)
        self.assertIn("missing fields: description", str(caught.exception))
        self.assertIn("unknown fields: unexpected", str(caught.exception))

    def test_impact_date_requires_exact_format_and_real_calendar_date(self):
        for value in ["2024/02/29", "2026/09/13", "2025/02/29", "2026/04/31",
                      "2026/9/13", "2026-09-13", "0000/01/01", "", None, 20260913]:
            with self.subTest(value=value):
                self.write(self.impact_path, {**self.impact, "occurred_by": value})
                if value in ["2024/02/29", "2026/09/13"]:
                    load_catalog(self.root)
                else:
                    with self.assertRaisesRegex(ValueError, "occurred_by"):
                        load_catalog(self.root)
        record = dict(self.impact)
        del record["occurred_by"]
        self.write(self.impact_path, record)
        with self.assertRaisesRegex(ValueError, "missing fields: occurred_by"):
            load_catalog(self.root)

    def test_contributor_answer_requires_an_explicit_boolean(self):
        for path, record in [(self.impact_path, self.impact)]:
            for value in [None, "yes", "false", 0, 1, True, False]:
                with self.subTest(path=path.name, value=value):
                    self.write(path, {**record, "submitter_is_contributor": value})
                    if isinstance(value, bool):
                        load_catalog(self.root)
                    else:
                        with self.assertRaisesRegex(ValueError, "submitter_is_contributor"):
                            load_catalog(self.root)
            missing = dict(record)
            del missing["submitter_is_contributor"]
            self.write(path, missing)
            with self.assertRaisesRegex(ValueError, "missing fields: submitter_is_contributor"):
                load_catalog(self.root)
            self.write(path, record)

    def test_rejects_invalid_ids(self):
        for identifier in ["not-a-uuid", "12345678-1234-1234-1234-123456789abc"]:
            self.write(self.impact_path, {**self.impact, "id": identifier})
            with self.assertRaises(ValueError):
                load_catalog(self.root)

    def test_rejects_duplicate_ids(self):
        self.write(self.root / "impacts" / "duplicate.json", self.impact)
        with self.assertRaisesRegex(ValueError, "duplicate id"):
            load_catalog(self.root)

    def test_rejects_invalid_json_and_non_object_records(self):
        for contents in ["{", "[]", "null"]:
            with self.subTest(contents=contents):
                self.impact_path.write_text(contents)
                with self.assertRaises(ValueError):
                    load_catalog(self.root)


if __name__ == "__main__":
    unittest.main()
