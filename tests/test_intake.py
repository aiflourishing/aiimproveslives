import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.intake import fenced_json, parse_submission, process
from scripts.build_catalog import build


class FakeGitHub:
    def __init__(self):
        self.calls = []
        self.comments = []
        self.previous = []
        self.pending = []

    def call(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if path.startswith('pulls?'):
            return self.previous
        if path.startswith('git/commits/'):
            return {'tree': {'sha': 'base-tree'}}
        if path == 'git/trees':
            return {'sha': 'new-tree'}
        if path == 'git/commits':
            return {'sha': 'new-commit'}
        if path.startswith('git/matching-refs/'):
            return []
        if path == 'pulls':
            return {'html_url': 'https://github.com/org/repo/pull/2'}
        return {}

    def pages(self, path):
        return iter(self.pending)

    def comment_once(self, number, text):
        self.comments.append(text)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for kind in ('profiles', 'impacts', 'intake'):
            (self.root / kind).mkdir()
        self.profile = {'id': 'project', 'name': 'A project', 'description': 'What it does.',
                        'types': ['system'], 'url': 'https://example.org',
                        'contributors': 'Jane Doe, Alex Smith'}
        self.event = {
            'sender': {'type': 'User'},
            'repository': {'full_name': 'org/repo', 'owner': {'login': 'org'}, 'default_branch': 'main'},
            'issue': {'id': 123, 'number': 1, 'html_url': 'https://github.com/org/repo/issues/1',
                      'body': self.body('Profile', self.profile)},
        }

    def body(self, kind, record):
        return f'### {kind} JSON\n\n```json\n{json.dumps(record)}\n```\n\n### Are you one of the contributor(s)?\n\nNo\n'

    def accept(self):
        relative, record, mapping = parse_submission(self.event, self.root)
        (self.root / relative).write_text(json.dumps(record))
        (self.root / 'intake/1.json').write_text(json.dumps(mapping))
        return record

    def update(self, record):
        self.event['comment'] = {'id': 456, 'html_url': 'https://github.com/org/repo/issues/1#issuecomment-456',
                                 'body': '/update\n```json\n' + json.dumps(record) + '\n```'}

    def test_initial_profile_and_names(self):
        relative, record, mapping = parse_submission(self.event, self.root)
        self.assertEqual(str(relative), 'profiles/project.json')
        self.assertEqual(record['contributors'], ['Jane Doe', 'Alex Smith'])
        self.assertIs(record['submitter_is_contributor'], False)
        self.assertEqual(mapping['issue_url'], self.event['issue']['html_url'])
        self.assertFalse((self.root / relative).exists())

    def test_impact_ids_are_stable_and_references_resolve(self):
        self.accept()
        self.event['issue'].update(number=2, html_url='https://github.com/org/repo/issues/2')
        self.event['issue']['body'] = self.body('Impact', {
            'profile_id': '@project', 'title': 'Benefit', 'description': 'Observed benefit.',
            'sources': ['https://example.org/evidence']})
        first = parse_submission(self.event, self.root)
        second = parse_submission(self.event, self.root)
        self.assertEqual(first, second)
        self.assertEqual(first[0].stem, first[1]['id'])

    def test_update_targets_bound_record_and_preserves_accepted_file(self):
        record = self.accept()
        original = (self.root / 'profiles/project.json').read_bytes()
        record['description'] = 'Updated description.'
        self.update(record)
        relative, updated, _ = parse_submission(self.event, self.root)
        self.assertEqual(str(relative), 'profiles/project.json')
        self.assertEqual(updated['description'], 'Updated description.')
        self.assertEqual((self.root / relative).read_bytes(), original)
        record['id'] = 'another-project'
        self.update(record)
        with self.assertRaisesRegex(ValueError, 'unchanged'):
            parse_submission(self.event, self.root)

    def test_invalid_input_and_traversal_never_write_records(self):
        for identifier in ['../../escape', '/tmp/escape', 'UPPER']:
            self.event['issue']['body'] = self.body('Profile', {**self.profile, 'id': identifier})
            with self.assertRaises(ValueError):
                parse_submission(self.event, self.root)
        self.assertEqual(list((self.root / 'profiles').iterdir()), [])
        for body in ['not JSON', '```json\n{}\n```\n```json\n{}\n```', '```json\n{"id":1,"id":2}\n```']:
            with self.assertRaises(ValueError):
                fenced_json(body)

    def test_update_before_acceptance_and_noop_are_rejected(self):
        self.update(self.profile)
        with self.assertRaisesRegex(ValueError, 'initial submission PR'):
            parse_submission(self.event, self.root)
        del self.event['comment']
        record = self.accept()
        self.update(record)
        with self.assertRaisesRegex(ValueError, 'No changes'):
            parse_submission(self.event, self.root)

    @patch('scripts.intake.subprocess.check_output', return_value='validated-base\n')
    def test_creates_only_record_and_mapping_then_linked_pr(self, git):
        api = FakeGitHub()
        process(self.event, self.root, api)
        tree = next(payload for method, path, payload in api.calls if path == 'git/trees')
        self.assertEqual({item['path'] for item in tree['tree']},
                         {'data/profiles/project.json', 'data/intake/1.json'})
        commit = next(payload for method, path, payload in api.calls if path == 'git/commits')
        self.assertEqual(commit['parents'], ['validated-base'])
        pr = next(payload for method, path, payload in api.calls if path == 'pulls')
        self.assertIn('Related Issue: #1', pr['body'])
        self.assertNotIn('Closes', pr['body'])
        self.assertTrue(pr['head'].startswith('codex/intake-1-'))

    def test_repeated_event_and_pending_pr_do_not_create_another_pr(self):
        api = FakeGitHub()
        api.previous = [{'html_url': 'https://github.com/org/repo/pull/2'}]
        process(self.event, self.root, api)
        self.assertFalse(any(method == 'POST' for method, _, _ in api.calls))
        api.previous = []
        api.pending = [{'html_url': 'https://github.com/org/repo/pull/2',
                        'head': {'ref': 'codex/intake-1-other', 'repo': {'full_name': 'org/repo'}}}]
        process(self.event, self.root, api)
        self.assertIn('already pending', api.comments[-1])
        self.assertFalse(any(method == 'POST' for method, _, _ in api.calls))

    def test_unrelated_comments_bots_and_pr_comments_are_ignored(self):
        for mode in ['comment', 'bot', 'pr']:
            event = copy.deepcopy(self.event)
            if mode == 'comment':
                event['comment'] = {'body': 'Please change the title'}
            elif mode == 'bot':
                event['sender']['type'] = 'Bot'
            else:
                event['issue']['pull_request'] = {}
            api = FakeGitHub()
            process(event, self.root, api)
            self.assertEqual(api.calls, [])
            self.assertEqual(api.comments, [])

    def test_invalid_submission_returns_feedback_without_creating_pr(self):
        self.event['issue']['body'] = self.body('Profile', {**self.profile, 'url': 'invalid'})
        api = FakeGitHub()
        process(self.event, self.root, api)
        self.assertIn('Submission needs changes', api.comments[0])
        self.assertEqual(api.calls, [])

    @patch('scripts.intake.subprocess.check_output', return_value='validated-base\n')
    def test_update_pr_changes_only_bound_record(self, git):
        record = self.accept()
        record['description'] = 'Updated benefit with new evidence.'
        self.update(record)
        api = FakeGitHub()
        process(self.event, self.root, api)
        tree = next(payload for method, path, payload in api.calls if path == 'git/trees')
        self.assertEqual([item['path'] for item in tree['tree']], ['data/profiles/project.json'])
        pr = next(payload for method, path, payload in api.calls if path == 'pulls')
        self.assertIn(self.event['comment']['html_url'], pr['body'])

    def test_catalog_build_excludes_intake_metadata(self):
        record = self.accept()
        output = self.root / 'output/catalog.json'
        build(self.root, output)
        self.assertEqual(json.loads(output.read_text()), {
            'profiles': {'project': record}, 'impacts': {}})

    def test_catalog_build_rejects_invalid_records(self):
        record = self.accept()
        record['url'] = 'invalid'
        (self.root / 'profiles/project.json').write_text(json.dumps(record))
        output = self.root / 'output/catalog.json'
        with self.assertRaises(ValueError):
            build(self.root, output)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
