import unittest
from scripts.sync_voting import snapshot, GITHUB_SCORES

ID = '12345678-1234-1234-1234-123456789abc'


class FakeGitHub:
    def pages(self, path):
        if path == 'pulls?state=closed':
            return [{'number': 3, 'merged_at': '2026-03-01'},
                    {'number': 1, 'merged_at': '2026-01-01'},
                    {'number': 2, 'merged_at': None}]
        if path == 'pulls/1/files':
            return [{'filename': f'data/impacts/{ID}.json', 'status': 'added'}]
        if path == 'issues/1/reactions':
            return [{'id': i, 'content': key, 'user': {'id': 100 + i},
                     'created_at': '2026-01-01T00:00:00Z'} for i, key in enumerate(GITHUB_SCORES, 1)]
        raise AssertionError(path)


class VotingTests(unittest.TestCase):
    def test_all_eight_github_reactions_have_requested_weights(self):
        self.assertEqual({k for k, v in GITHUB_SCORES.items() if v < 0}, {'-1', 'confused'})
        self.assertEqual({k for k, v in GITHUB_SCORES.items() if v > 0}, {'+1', 'heart', 'hooray', 'rocket', 'eyes'})

        self.assertEqual(GITHUB_SCORES['laugh'], 0)

    def test_original_merged_pr_only_and_full_snapshot(self):
        result = snapshot({'impacts': {ID: {}}}, FakeGitHub())
        self.assertEqual(result['p_impacts'], [ID])
        self.assertEqual(len(result['p_reactions']), 8)
        self.assertEqual(result['p_submitted_at'][ID], '2026-01-01')
        self.assertEqual({r['impact_id'] for r in result['p_reactions']}, {ID})
        self.assertTrue(all('github_user_id' in r and 'created_at' in r for r in result['p_reactions']))

    def test_failed_fetch_does_not_produce_partial_snapshot(self):
        class Broken(FakeGitHub):
            def pages(self, path):
                if path.startswith('issues/'):
                    raise RuntimeError('API unavailable')
                return super().pages(path)
        with self.assertRaises(RuntimeError):
            snapshot({'impacts': {ID: {}}}, Broken())

    def test_deleted_impacts_are_absent(self):
        self.assertEqual(snapshot({'impacts': {}}, FakeGitHub()), {'p_impacts': [], 'p_reactions': [], 'p_submitted_at': {}})

    def test_original_submission_date_overrides_pr_approval_time(self):
        result = snapshot({'impacts': {ID: {}}}, FakeGitHub(), {ID: '2025-12-01T12:00:00Z'})
        self.assertEqual(result['p_submitted_at'][ID], '2025-12-01T12:00:00Z')
