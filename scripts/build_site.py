"""Build a dependency-free website, including real URLs for every record."""
import html
import json
import re
import hashlib
import shutil
import subprocess
from pathlib import Path

from scripts.catalog import ROOT, load_catalog
from scripts.build_catalog import build as build_catalog

SOURCE = Path(__file__).resolve().parents[1] / 'src'


def esc(value):
    return html.escape(str(value), quote=True)


def render_about(source):
    """Render the About page's basic Markdown without build dependencies.

    Supports headings, paragraphs, flat bullet lists, bold, italic, and links.
    Raw HTML is escaped; links accept only web, email, or local destinations.
    """
    def inline(text):
        def token(match):
            label, url, bold, italic = match.groups()
            if label is not None:
                if url == '#share':
                    return ('<span class="share-control inline-share">'
                            '<button type="button" class="inline-share-button" '
                            'data-share-url="https://aiimproveslives.com/about/" '
                            'data-share-title="AI Improves Lives" hidden>' + inline(label) + '</button>'
                            '<span class="share-toast" role="status" hidden></span>'
                            '<label class="share-fallback" hidden>Copy this link'
                            '<input type="url" readonly aria-label="Page link"></label></span>')
                from urllib.parse import urlsplit
                if urlsplit(url).scheme.lower() not in ('', 'http', 'https', 'mailto'):
                    return esc(match[0])
                return f'<a href="{esc(url)}">{inline(label)}</a>'
            if bold is not None:
                return f'<strong>{esc(bold)}</strong>'
            return f'<em>{esc(italic)}</em>'

        pattern = re.compile(r'\[([^\]\n]+)\]\(([^\s()]+)\)|\*\*(.+?)\*\*|\*([^*]+)\*')
        result = []
        start = 0
        for match in pattern.finditer(text):
            result.extend((esc(text[start:match.start()]), token(match)))
            start = match.end()
        result.append(esc(text[start:]))
        return ''.join(result)

    blocks = []
    paragraph = []
    bullets = []

    def flush():
        if paragraph:
            blocks.append('<p>' + inline(' '.join(paragraph)) + '</p>')
            paragraph.clear()
        if bullets:
            blocks.append('<ul>' + ''.join('<li>' + inline(item) + '</li>' for item in bullets) + '</ul>')
            bullets.clear()

    for line in (source / 'about.md').read_text(encoding='utf-8').splitlines():
        line = line.strip()
        heading = re.fullmatch(r'(#{1,6})\s+(.+)', line)
        bullet = re.fullmatch(r'[-*]\s+(.+)', line)
        if not line or heading:
            flush()
            if heading:
                level = len(heading[1])
                blocks.append(f'<h{level}>' + inline(heading[2]) + f'</h{level}>')
        elif bullet:
            if paragraph:
                flush()
            bullets.append(bullet[1])
        else:
            if bullets:
                flush()
            paragraph.append(line)
    flush()
    return '<article class="reading about blog-post">\n' + '\n'.join(blocks) + '\n</article>\n'


def contribution_copy(source):
    text = (source / 'contribute-copy.md').read_text(encoding='utf-8')
    parts = re.split(r'^## (.+)\n', text, flags=re.M)
    copy = {}
    for label, wording in zip(parts[1::2], parts[2::2]):
        if label in copy:
            raise ValueError(f'Duplicate heading in contribute-copy.md: {label}')
        copy[label] = wording.strip()
    return copy


def render_contribution(source):
    copy = contribution_copy(source)
    template = (source / 'contribute.html').read_text(encoding='utf-8')
    def replace(match):
        label = match[1]
        if label not in copy:
            raise ValueError(f'Missing heading in contribute-copy.md: {label}')
        return esc(copy[label])
    content = re.sub(r'\{\{([^{}]+)\}\}', replace, template)
    # Plain text remains data, including quotes or HTML someone writes in the copy file.
    data = json.dumps(copy, ensure_ascii=False).replace('<', '\\u003c')
    return content + '<script id="contribution-copy" type="application/json">' + data + '</script>'


def page(title, content, prefix='./', home=False, source=SOURCE, path=''):
    def asset(name):
        digest = hashlib.sha256((source / name).read_bytes()).hexdigest()[:10]
        return f'{prefix}{name}?v={digest}'
    impact_current = ' aria-current="page"' if home else ''
    contribute_current = ' aria-current="page"' if title == 'Contribute' else ''
    contribute_script = f"<script defer src=\"{asset('contribute.js')}\"></script>" if title == 'Contribute' else ''
    about_current = ' aria-current="page"' if title == 'About' else ''
    footer = '' if title == 'About' else f'''<footer><div class="share-control footer-share"><button type="button" class="footer-share-button" data-copy-url="{esc('https://aiimproveslives.com/' + path)}" hidden>Know someone who’d find this inspiring? Share it!</button><span class="share-toast" role="status" hidden></span><label class="share-fallback" hidden>Copy this link<input type="url" readonly aria-label="Page link"></label></div></footer>'''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} — AI Improves Lives</title><meta name="theme-color" content="#f7f6ef">
<link rel="stylesheet" href="{asset('styles.css')}"><script defer src="{asset('site.js')}"></script><script defer src="{asset('voting.js')}"></script>{contribute_script}</head>
<body data-base="{prefix}"><a class="skip" href="#main">Skip to content</a>
<header class="site-header"><a class="brand" href="{prefix}" aria-label="AI Improves Lives"{impact_current}><span class="brand-mark" aria-hidden="true">aı</span></a>
<nav aria-label="Main"><a href="{prefix}contribute/"{contribute_current}>Submit</a><a href="{prefix}about/"{about_current}>About</a></nav></header>
<main id="main" {'class="home"' if home else 'class="detail"'}>{content}</main>
<dialog id="signin" aria-labelledby="signin-title"><button class="dialog-close" aria-label="Close">×</button><h2 id="signin-title">Sign in</h2><button id="google-signin" class="signin-primary provider-button"><svg class="provider-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.06.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg><span>Continue with Google</span></button><button id="github-signin" class="signin-primary provider-button"><svg class="provider-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.469-2.38 1.236-3.22-.135-.303-.54-1.524.105-3.176 0 0 1.008-.322 3.301 1.23a11.5 11.5 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.647 1.652.242 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.804 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg><span>Continue with GitHub</span></button><button id="signout" class="signin-primary" hidden>Sign out</button><p id="auth-status" role="status"></p></dialog><p id="vote-status" class="vote-status" role="status" hidden></p>
{footer}</body></html>'''


def photo(record, detail=False):
    if not record.get('image'):
        return '' if detail else '<div class="card-image image-empty" aria-hidden="true"><span class="brand-mark">aı</span></div>'
    loading = '' if detail else 'loading="lazy"'
    return f'<img class="{"detail-image" if detail else "card-image"}" src="{esc(record["image"])}" alt="" {loading} decoding="async">'


def date(record):
    from datetime import datetime
    return datetime.strptime(record['occurred_by'], '%Y/%m/%d').strftime('%B %d, %Y').replace(' 0', ' ')


def reactions(identifier, score=None):
    visible_score = str(score) if isinstance(score, int) and not isinstance(score, bool) and score > 5 else ''
    score_attributes = f' aria-label="Score {visible_score}"' if visible_score else ' hidden'
    return f'''<div class="reactions" role="group" aria-label="Rate this listing" data-impact="{identifier}"><button type="button" data-reaction="heart" aria-label="Like" title="Like" aria-pressed="false">❤️</button><span class="vote-score" data-score-for="{identifier}"{score_attributes}>{visible_score}</span><button type="button" data-reaction="confused" aria-label="Dislike" title="Dislike" aria-pressed="false">👎</button></div>'''


def share_control(record):
    url = f'https://aiimproveslives.com/impacts/{record["id"]}/'
    return f'''<div class="share-control"><button type="button" class="share-button" data-share-url="{esc(url)}" data-share-title="{esc(record['title'])}" aria-label="Share this entry" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg><span>Share</span></button><span class="share-toast" role="status" hidden></span><label class="share-fallback" hidden>Copy this link<input type="url" readonly aria-label="Entry link"></label></div>'''



def card(record, prefix='./', new_order=0, score=None):
    description = record['description']
    excerpt = description[:140] + ('...' if len(description) > 140 else '')
    search = ' '.join([record['title'], description])
    return f'''<article class="card" data-impact="{record['id']}" data-search="{esc(search.lower())}" data-new-order="{new_order}">
{photo(record)}<div class="card-body"><div class="card-title"><h3><a class="impact-link" href="{prefix}impacts/{record['id']}/">{esc(record['title'])}</a></h3></div>
<p>{esc(excerpt)}</p><div class="card-actions">{reactions(record["id"], score)}{share_control(record)}</div></div></article>'''


def links(record):
    result = ''
    if record.get('sources'):
        from urllib.parse import urlsplit
        result += '<section class="evidence"><h2>Learn More</h2><ol>'
        for url in record['sources']:
            result += f'<li><a href="{esc(url)}">{esc(urlsplit(url).netloc)} <span aria-hidden="true">↗</span></a></li>'
        result += '</ol></section>'
    return result


def added_at(root, record):
    """New means accepted on main, using the first-parent commit that introduced the record."""
    try:
        result = subprocess.run(['git', 'log', '--first-parent', '--diff-filter=A', '--format=%cI', '--', str((root / 'impacts' / (record['id'] + '.json')).resolve())], cwd=root, capture_output=True, text=True, check=True)
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else record['occurred_by'].replace('/', '-')
    except (OSError, subprocess.CalledProcessError):
        return record['occurred_by'].replace('/', '-')


def build(root=ROOT, output=Path('dist'), source=SOURCE, ranking=None):
    catalog = load_catalog(root)
    impacts = catalog['impacts']
    output.mkdir(parents=True, exist_ok=True)
    for directory in ['impacts', 'projects', 'privacy']:
        if (output / directory).exists():
            shutil.rmtree(output / directory)
    build_catalog(root, output / 'catalog.json')
    for filename in ['styles.css', 'site.js', 'voting.js', 'contribute.js', 'voting-config.json']:
        shutil.copyfile(source / filename, output / filename)
    shutil.copytree(source / 'vendor', output / 'vendor', dirs_exist_ok=True)
    (output / '.nojekyll').touch()
    ordered = sorted(impacts.values(), key=lambda r: (added_at(root, r), r['id']), reverse=True)
    new_order = {record['id']: index for index, record in enumerate(ordered)}
    scores = {row['impact_id']: row.get('score') for row in (ranking or []) if row.get('impact_id') in impacts}
    initial_ranking = None
    if ranking is not None:
        ids = [row['impact_id'] for row in ranking if row.get('impact_id') in impacts]
        ids = list(dict.fromkeys(ids))
        initial_ranking = ids + [record['id'] for record in ordered if record['id'] not in ids]
        ranks = {identifier: index for index, identifier in enumerate(initial_ranking)}
        ordered.sort(key=lambda record: ranks[record['id']])
    new_cards = ''.join(card(r, new_order=new_order[r['id']], score=scores.get(r['id'])) for r in ordered)
    initial_data = '' if initial_ranking is None else '<script type="application/json" id="initial-ranking">' + json.dumps(initial_ranking) + '</script>'
    content = f'''<div class="page-top"><h1>AI Improves Lives</h1></div>
<div class="listing-toolbar"><div class="sort-controls" role="group" aria-label="Order impacts"><button type="button" data-sort="top" aria-pressed="true">Top</button><button type="button" data-sort="new" aria-pressed="false">New</button></div><form class="search" role="search"><label class="sr-only" for="search">Search</label><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Search" autocomplete="off"><button type="reset" hidden>Clear</button></form></div>
<p id="search-status" class="sr-only" role="status" aria-live="polite"></p><p id="ranking-status" class="ranking-status" role="status" hidden></p>
<section id="impacts" aria-label="Impacts"><div class="card-grid">{new_cards}</div>{initial_data}<p class="empty" {'hidden' if impacts else ''}>No listings yet.</p></section>'''
    (output / 'index.html').write_text(page('Home', content, home=True, source=source), encoding='utf-8')
    about = output / 'about'
    about.mkdir(exist_ok=True)
    about_content = render_about(source)
    (about / 'index.html').write_text(page('About', about_content, '../', source=source, path='about/'), encoding='utf-8')
    contribute = output / 'contribute'
    contribute.mkdir(exist_ok=True)
    contribute_content = render_contribution(source)
    (contribute / 'index.html').write_text(page('Contribute', contribute_content, '../', source=source, path='contribute/'), encoding='utf-8')
    for record in impacts.values():
        content = f'''<article class="reading listing-detail"><a class="back" href="../../#impacts"><span aria-hidden="true">←</span><span>All</span></a><header class="listing-heading"><h1>{esc(record['title'])}</h1>{photo(record, True)}</header><p class="description">{esc(record['description'])}</p><div class="detail-reactions">{reactions(record["id"], scores.get(record["id"]))}{share_control(record)}</div>{links(record)}<p class="reported-date">Reported as of <time datetime="{record['occurred_by'].replace('/', '-')}">{date(record)}</time></p></article>'''
        target = output / 'impacts' / record['id']
        target.mkdir(parents=True)
        (target / 'index.html').write_text(page(record['title'], content, '../../', source=source, path=f'impacts/{record["id"]}/'), encoding='utf-8')
    return output


if __name__ == '__main__':
    import argparse
    from urllib.request import Request, urlopen
    parser = argparse.ArgumentParser()
    parser.add_argument('--live-ranking', action='store_true', help='Bake the public Top ranking into the page')
    args = parser.parse_args()
    ranking = None
    if args.live_ranking:
        try:
            config = json.loads((SOURCE / 'voting-config.json').read_text())
            request = Request(config['url'].rstrip('/') + '/rest/v1/rpc/impact_scores', data=b'{}', method='POST',
                              headers={'apikey': config['publishableKey'], 'Content-Type': 'application/json'})
            with urlopen(request, timeout=10) as response:
                ranking = json.load(response)
            if not isinstance(ranking, list):
                raise ValueError('Invalid public ranking')
        except (OSError, ValueError, KeyError):
            print('Public ranking unavailable; building with newest fallback.')
            ranking = None
    print(build(ranking=ranking))
