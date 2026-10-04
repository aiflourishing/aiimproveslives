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
        for filename in ['styles.css', 'site.js', 'voting.js', 'contribute.js', 'contribute.html', 'contribute-copy.md', 'about.md', 'voting-config.json', 'favicon.svg']:
            (self.source / filename).write_text((SOURCE / filename).read_text())
        shutil.copyfile(SOURCE / 'share-preview.png', self.source / 'share-preview.png')
        shutil.copytree(SOURCE / 'vendor', self.source / 'vendor')
        self.output = self.base / 'dist'
        self.identifier = '12345678-1234-1234-1234-123456789abc'
        self.impact = dict(id=self.identifier, title='<script>alert(1)</script>', description='A' * 141, occurred_by='2025/01/03', sources=['https://example.org/source'], submitter_is_contributor=False, image='https://example.org/photo.jpg')

    def populate(self):
        (self.data / f'impacts/{self.identifier}.json').write_text(json.dumps(self.impact))

    def test_empty_catalog_builds(self):
        build(self.data, self.output, self.source)
        self.assertIn('No listings yet.', (self.output / 'index.html').read_text())

    def test_real_pages_links_and_escaping(self):
        self.populate()
        build(self.data, self.output, self.source)
        home = (self.output / 'index.html').read_text()
        detail = (self.output / 'script-alert-1-script/index.html').read_text()
        self.assertNotIn('<p>' + 'A' * 140, home)
        self.assertIn('a' * 141, home)  # Full description remains searchable.
        self.assertIn('A' * 141, detail)
        self.assertNotIn('<script>alert', home)
        self.assertIn('&lt;script&gt;', home)
        self.assertIn('./script-alert-1-script/', home)
        self.assertNotIn('projects/', detail)
        self.assertFalse((self.output / 'projects').exists())
        self.assertNotIn('id="year"', home)
        self.assertNotIn('All years', home)
        self.assertLess(detail.index('<h1>'), detail.index('detail-image'))
        self.assertNotIn('Reported as of', detail)
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
        self.assertNotIn('👎', home)
        self.assertIn('❤️', home)
        self.assertNotIn('<time', home)
        self.assertNotIn('data-reaction="confused"', home)
        detail = (self.output / 'script-alert-1-script/index.html').read_text()
        self.assertNotIn('👎', detail)
        self.assertNotIn('data-reaction="confused"', detail)
        self.assertIn('data-reaction="heart"', detail)
        self.assertNotIn('🤔', home)
        self.assertIn('Continue with GitHub', home)

    def test_navigation_and_contribute_page(self):
        self.populate()
        build(self.data, self.output, self.source)
        for path in ['index.html', 'contribute/index.html', 'script-alert-1-script/index.html']:
            page = (self.output / path).read_text()
            nav = page.split('<nav aria-label="Main">')[1].split('</nav>')[0]
            self.assertIn('>Submit</a>', nav)
            self.assertNotIn('>About</a>', nav)
            self.assertNotIn('>Impact</a>', nav)
            self.assertNotIn('Sign in', nav)
            self.assertNotIn('id="account"', page)
        redirect = (self.output / 'about/index.html').read_text()
        self.assertIn('content="0; url=../"', redirect)
        home = (self.output / 'index.html').read_text()
        self.assertIn('data-copy-url="https://aiimproveslives.com/"', home)
        self.assertIn('href="./contribute/"', home)
        self.assertNotIn('class="landing-intro"', home)
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
        self.assertFalse((self.output / 'script-alert-1-script').exists())

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

    def test_readable_urls_and_share_links(self):
        self.impact['title'] = "OpenStreetMap's fAIr helps disaster response"
        self.populate()
        build(self.data, self.output, self.source)
        path = 'openstreetmaps-fair-helps-disaster-response/'
        detail = (self.output / path / 'index.html').read_text()
        home = (self.output / 'index.html').read_text()
        self.assertIn(f'href="./{path}"', home)
        self.assertIn(f'data-share-url="https://aiimproveslives.com/{path}"', detail)
        self.assertIn(f'data-copy-url="https://aiimproveslives.com/{path}"', detail)
        self.assertIn(f'<link rel="canonical" href="https://aiimproveslives.com/{path}">', detail)
        self.assertIn('href="../#impacts"', detail)
        self.assertIn('src="../voting.js?v=', detail)
        self.assertFalse((self.output / 'impacts').exists())

    def test_title_url_collisions_and_reserved_paths(self):
        from scripts.build_site import impact_paths
        records = {str(i): {'title': title} for i, title in enumerate(['Contribute', 'Contribute', 'Café & Care', 'Cafe Care', '!!!'])}
        paths = impact_paths(records)
        self.assertEqual(len(set(paths.values())), 5)
        self.assertNotIn('contribute/', paths.values())
        self.assertEqual(paths['2'], 'cafe-care/')
        self.assertEqual(paths['3'], 'cafe-care-2/')
        self.assertEqual(paths['4'], 'entry/')

    def test_product_urls_override_titles_and_remain_stable(self):
        self.populate()
        (self.source / 'impact-slugs.json').write_text(json.dumps({self.identifier: 'fair'}))
        build(self.data, self.output, self.source)
        home = (self.output / 'index.html').read_text()
        self.assertIn('href="./fair/"', home)
        self.assertTrue((self.output / 'fair/index.html').exists())
        self.impact['title'] = 'An updated title'
        self.populate()
        build(self.data, self.output, self.source)
        self.assertTrue((self.output / 'fair/index.html').exists())
        self.assertFalse((self.output / 'an-updated-title').exists())
        from scripts.build_site import impact_paths
        with self.assertRaises(ValueError):
            impact_paths({self.identifier: self.impact}, {self.identifier: 'contribute'})

    def test_top_equal_scores_follow_impact_dates_not_server_order(self):
        self.populate()
        second = '12345678-1234-1234-1234-123456789abd'
        (self.data / f'impacts/{second}.json').write_text(json.dumps({**self.impact, 'id': second, 'occurred_by': '2026/01/03'}))
        build(self.data, self.output, self.source, ranking=[{'impact_id': self.identifier, 'score': 3}, {'impact_id': second, 'score': 3}])
        home = (self.output / 'index.html').read_text()
        self.assertLess(home.index(f'data-impact="{second}"'), home.index(f'data-impact="{self.identifier}"'))
        initial = home.split('id="initial-ranking">')[1].split('</script>')[0]
        self.assertEqual(json.loads(initial), [second, self.identifier])

    def test_hidden_scores_use_rank_groups_or_preserve_server_order(self):
        self.populate()
        second = '12345678-1234-1234-1234-123456789abd'
        (self.data / f'impacts/{second}.json').write_text(json.dumps({**self.impact, 'id': second, 'occurred_by': '2026/01/03'}))
        for ranking, expected in [
            ([{'impact_id': self.identifier, 'score': None, 'vote_rank': 1}, {'impact_id': second, 'score': None, 'vote_rank': 2}], [self.identifier, second]),
            ([{'impact_id': self.identifier, 'score': None, 'vote_rank': 1}, {'impact_id': second, 'score': None, 'vote_rank': 1}], [second, self.identifier]),
            ([{'impact_id': self.identifier, 'score': None}, {'impact_id': second, 'score': None}], [self.identifier, second]),
        ]:
            build(self.data, self.output, self.source, ranking=ranking)
            home = (self.output / 'index.html').read_text()
            initial = home.split('id="initial-ranking">')[1].split('</script>')[0]
            self.assertEqual(json.loads(initial), expected)
