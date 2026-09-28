import json
import tempfile
import shutil
import unittest
from pathlib import Path
from scripts.build_site import build, SOURCE


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.data = self.base / 'data'
        for kind in ['impacts']:
            (self.data / kind).mkdir(parents=True)
        self.source = self.base / 'src'
        self.source.mkdir()
        for filename in ['styles.css', 'site.js', 'voting.js', 'contribute.js', 'contribute.html', 'contribute-copy.md', 'about.html', 'voting-config.json']:
            (self.source / filename).write_text((SOURCE / filename).read_text())
        shutil.copytree(SOURCE / 'vendor', self.source / 'vendor')
        self.output = self.base / 'dist'
        self.identifier = '12345678-1234-1234-1234-123456789abc'
        self.impact = dict(id=self.identifier, title='<script>alert(1)</script>', description='A' * 141, occurred_by='2025/01/03', sources=['https://example.org/source'], submitter_is_contributor=False, image='https://example.org/photo.jpg')

    def populate(self):
        (self.data / f'impacts/{self.identifier}.json').write_text(json.dumps(self.impact))

    def test_empty_catalog_builds(self):
        build(self.data, self.output, self.source)
        self.assertIn('No listings yet.', (self.output / 'index.html').read_text())

    def test_real_pages_links_excerpt_and_escaping(self):
        self.populate()
        build(self.data, self.output, self.source)
        home = (self.output / 'index.html').read_text()
        detail = (self.output / f'impacts/{self.identifier}/index.html').read_text()
        self.assertIn('A' * 140 + '...', home)
        self.assertNotIn('A' * 141, home)
        self.assertIn('A' * 141, detail)
        self.assertNotIn('<script>alert', home)
        self.assertIn('&lt;script&gt;', home)
        self.assertIn(f'./impacts/{self.identifier}/', home)
        self.assertNotIn('projects/', detail)
        self.assertFalse((self.output / 'projects').exists())
        self.assertNotIn('id="year"', home)
        self.assertNotIn('All years', home)
        self.assertLess(detail.index('<h1>'), detail.index('detail-image'))
        self.assertIn('Reported as of', detail)
        self.assertNotIn('Impact ·', detail)
        self.assertLess(detail.index('class="description"'), detail.index('detail-reactions'))

    def test_vote_controls_hide_initial_score_and_preserve_storage_mapping(self):
        self.populate()
        build(self.data, self.output, self.source)
        home = (self.output / 'index.html').read_text()
        self.assertIn(f'data-score-for="{self.identifier}" hidden', home)
        self.assertNotIn('project-link', home)
        self.assertIn('title="Like"', home)
        self.assertNotIn('data-reaction="improved"', home)
        self.assertIn('👎', home)
        self.assertIn('❤️', home)
        self.assertNotIn('<time', home)
        self.assertIn('data-reaction="confused"', home)
        self.assertNotIn('🤔', home)
        self.assertIn('Continue with GitHub', home)

    def test_navigation_and_contribute_page(self):
        self.populate()
        build(self.data, self.output, self.source)
        for path in ['index.html', 'about/index.html', 'contribute/index.html', f'impacts/{self.identifier}/index.html']:
            page = (self.output / path).read_text()
            nav = page.split('<nav aria-label="Main">')[1].split('</nav>')[0]
            self.assertIn('>Submit</a>', nav)
            self.assertIn('>About</a>', nav)
            self.assertNotIn('>Impact</a>', nav)
            self.assertNotIn('Sign in', nav)
            self.assertNotIn('id="account"', page)
        contribution = (self.output / 'contribute/index.html').read_text()
        self.assertIn('src="../contribute.js?v=', contribution)
        self.assertIn('name="sources"', contribution)
        self.assertIn('name="submitter_is_contributor"', contribution)
        self.assertIn('<h1>Help grow the collection</h1>', contribution)
        self.assertNotIn('id="contribute-content" hidden', contribution)
        self.assertNotIn('contribute-gate', contribution)

    def test_removes_stale_record_pages(self):
        self.populate()
        build(self.data, self.output, self.source)
        (self.data / f'impacts/{self.identifier}.json').unlink()
        build(self.data, self.output, self.source)
        self.assertFalse((self.output / f'impacts/{self.identifier}').exists())

    def test_top_is_baked_into_html_without_losing_new_order(self):
        self.populate()
        second = '12345678-1234-1234-1234-123456789abd'
        (self.data / f'impacts/{second}.json').write_text(json.dumps({**self.impact, 'id': second, 'occurred_by': '2026/01/03'}))
        build(self.data, self.output, self.source, ranking=[{'impact_id': self.identifier, 'score': 8}])
        home = (self.output / 'index.html').read_text()
        self.assertLess(home.index(f'data-impact="{self.identifier}"'), home.index(f'data-impact="{second}"'))
        self.assertIn(f'data-new-order="1"', home)
        self.assertIn('id="initial-ranking"', home)
        self.assertIn(f'data-score-for="{self.identifier}" aria-label="Score 8">8</span>', home)
        initial = home.split('id="initial-ranking">')[1].split('</script>')[0]
        self.assertEqual(json.loads(initial), [self.identifier, second])
