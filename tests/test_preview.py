import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.preview import ApprovedMirror
from scripts.build_site import build


class ApprovalPreviewTests(unittest.TestCase):
    def test_only_merged_records_appear_and_latest_impact_date_is_first(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            upstream = root / 'upstream'
            upstream.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(upstream), *args], text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-b', 'main')
            git('config', 'user.email', 'test@example.org')
            git('config', 'user.name', 'Local test')
            (upstream / 'data/impacts').mkdir(parents=True)
            (upstream / 'data/impacts/.gitkeep').touch()
            git('add', '.'); git('commit', '-m', 'Initial catalog')
            mirror = ApprovedMirror(root / 'mirror', str(upstream))
            self.assertTrue(mirror.refresh())
            output = root / 'site'
            build(mirror.data, output)
            self.assertIn('No listings yet.', (output / 'index.html').read_text())
            git('checkout', '-b', 'proposal')
            identifiers = ['ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000001']
            def add(identifier, title, date):
                record = dict(id=identifier, title=title, description='Benefit to multiple people.', sources=['https://example.org/one','https://example.org/two'], occurred_by=date, submitter_is_contributor=False)
                (upstream / 'data/impacts' / (identifier+'.json')).write_text(json.dumps(record))
                git('add', '.'); git('commit', '-m', title)
            add(identifiers[0], 'First accepted', '2026/01/01')
            self.assertFalse(mirror.refresh())
            build(mirror.data, output)
            self.assertNotIn('First accepted', (output / 'index.html').read_text())
            git('checkout', 'main'); git('merge', '--no-ff', 'proposal', '-m', 'Accept proposal')
            self.assertTrue(mirror.refresh())
            build(mirror.data, output)
            home = (output / 'index.html').read_text()
            self.assertIn('First accepted', home)
            detail = (output / 'impacts' / identifiers[0] / 'index.html').read_text()
            self.assertIn('https://example.org/one', detail)
            self.assertIn('https://example.org/two', detail)
            # A newly accepted record with an older impact date belongs after newer impacts.
            add(identifiers[1], 'Second accepted', '2020/01/01')
            git('commit', '--amend', '--no-edit', '--date=2027-01-01T00:00:00Z')
            # A later commit date must not override the recorded impact date.
            subprocess.run(['git','-C',str(upstream),'commit','--amend','--no-edit'], env={**__import__('os').environ,'GIT_COMMITTER_DATE':'2027-01-01T00:00:00Z'}, check=True, capture_output=True)
            mirror.refresh(); build(mirror.data, output)
            home = (output / 'index.html').read_text()
            self.assertLess(home.index('First accepted'), home.index('Second accepted'))
            git('rm', 'data/impacts/'+identifiers[0]+'.json'); git('commit', '-m', 'Remove impact')
            mirror.refresh(); build(mirror.data, output)
            self.assertFalse((output / 'impacts' / identifiers[0]).exists())
