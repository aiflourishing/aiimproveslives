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
        (self.root / "profiles").mkdir()
        self.profile_path = self.root / "profiles" / "sample-project.json"
        self.profile = {
            "id": "sample-project", "name": "Sample Project",
            "types": ["system", "dataset"], "description": "A sample project.",
            "url": "https://example.org",
            "submitter_is_contributor": False,
        }
        self.write(self.profile_path, self.profile)
        self.impact_path = new_impact(self.root, "@sample-project", " Jane Doe, Alex Smith , ")
        self.impact = json.loads(self.impact_path.read_text())
        self.impact.update(title="Sample benefit", description="An observed benefit.",
                           submitter_is_contributor=True,
                           sources=["https://example.org/evidence"],
                           cites=["@sample-project", "Another project"])
        self.write(self.impact_path, self.impact)

    def write(self, path, record):
        path.write_text(json.dumps(record), encoding="utf-8")

    def test_loads_linked_records_and_preserves_names(self):
        catalog = load_catalog(self.root)
        impact = catalog["impacts"][self.impact["id"]]
        self.assertEqual(impact["contributors"], ["Jane Doe", "Alex Smith"])
        self.assertEqual(impact["cites"], ["@sample-project", "Another project"])

    def test_generated_ids_are_distinct_and_existing_file_is_unchanged(self):
        original = self.impact_path.read_bytes()
        second = new_impact(self.root, "sample-project")
        self.assertNotEqual(second.stem, self.impact_path.stem)
        self.assertEqual(self.impact_path.read_bytes(), original)

    def test_rejects_missing_profile_and_cite_references(self):
        for field, value in [("profile_id", "@missing"), ("profile_id", "sample-project"),
                             ("cites", ["@missing"])]:
            with self.subTest(field=field, value=value):
                self.write(self.impact_path, {**self.impact, field: value})
                with self.assertRaisesRegex(ValueError, "existing @profile-id"):
                    load_catalog(self.root)

    def test_rejects_malformed_impact_fields(self):
        cases = {"sources": [[], ["not a url"], "https://example.org", [None]],
                 "title": ["", "   ", 1], "contributors": ["Jane Doe", [""]],
                 "cites": ["@sample-project", [{}]],
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

    def test_contributor_answer_requires_an_explicit_boolean_on_both_records(self):
        for path, record in [(self.profile_path, self.profile), (self.impact_path, self.impact)]:
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

    def test_rejects_invalid_types_and_ids(self):
        for field, value in [("types", []), ("types", ["unknown"]), ("types", [{}]),
                             ("id", "Upper Case"), ("id", "another-id")]:
            with self.subTest(field=field, value=value):
                self.write(self.profile_path, {**self.profile, field: value})
                with self.assertRaises(ValueError):
                    load_catalog(self.root)

    def test_rejects_duplicate_ids(self):
        self.write(self.root / "profiles" / "duplicate.json", self.profile)
        with self.assertRaisesRegex(ValueError, "duplicate id"):
            load_catalog(self.root)

    def test_profile_sources_and_contributors(self):
        profile = {**self.profile, "sources": ["https://example.org/report"],
                   "contributors": ["Jane Doe", "Alex Smith"]}
        self.write(self.profile_path, profile)
        self.assertEqual(load_catalog(self.root)["profiles"][profile["id"]], profile)
        for field, value in [("sources", ["not a url"]), ("sources", []),
                             ("sources", "https://example.org"),
                             ("contributors", "Jane Doe, Alex Smith"),
                             ("contributors", [""])]:
            with self.subTest(field=field, value=value):
                self.write(self.profile_path, {**profile, field: value})
                with self.assertRaises(ValueError):
                    load_catalog(self.root)

    def test_rejects_invalid_json_and_non_object_records(self):
        for contents in ["{", "[]", "null"]:
            with self.subTest(contents=contents):
                self.impact_path.write_text(contents)
                with self.assertRaises(ValueError):
                    load_catalog(self.root)


if __name__ == "__main__":
    unittest.main()
