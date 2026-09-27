"""Sync accepted impacts and their original merged PR reactions into Supabase."""
import json
import os
import subprocess
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from scripts.catalog import ROOT, load_catalog
from scripts.intake import GitHub

GITHUB_SCORES = {'+1': 1, '-1': -1, 'laugh': 0, 'confused': -1,
                 'heart': 1, 'hooray': 1, 'rocket': 1, 'eyes': 1}


def snapshot(catalog, github, submitted_at=None):
    dates = dict(submitted_at or {})
    impacts = catalog['impacts']
    canonical = {}
    # Earliest merged PR that added the file. Update PRs do not duplicate votes.
    merged = sorted((pr for pr in github.pages('pulls?state=closed') if pr.get('merged_at')),
                    key=lambda pr: (pr['merged_at'], pr['number']))
    for pr in merged:
        if len(canonical) == len(impacts):
            break
        for file in github.pages(f"pulls/{pr['number']}/files"):
            path = file['filename']
            if file['status'] == 'added' and path.startswith('data/impacts/') and path.endswith('.json'):
                identifier = path[len('data/impacts/'):-len('.json')]
                if identifier in impacts:
                    if identifier not in canonical:
                        canonical[identifier] = pr['number']
                        dates.setdefault(identifier, pr.get('created_at') or pr['merged_at'])
    cache, rows = {}, []
    for identifier, number in canonical.items():
        if number not in cache:
            cache[number] = list(github.pages(f'issues/{number}/reactions'))
        for reaction in cache[number]:
            if reaction['content'] not in GITHUB_SCORES:
                raise ValueError('Unknown GitHub reaction; scoring policy needs updating')
            rows.append(dict(reaction_id=reaction['id'], impact_id=identifier,
                             github_user_id=reaction['user']['id'], reaction=reaction['content'],
                             created_at=reaction['created_at']))
    return {'p_impacts': sorted(impacts), 'p_reactions': rows,
            'p_submitted_at': {key: value for key, value in dates.items() if key in impacts and value}}


def main():
    url = os.environ['SUPABASE_URL'].rstrip('/')
    if urlsplit(url).scheme != 'https':
        raise ValueError('SUPABASE_URL must use HTTPS')
    key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
    catalog = load_catalog()
    github = GitHub(os.environ['GITHUB_REPOSITORY'])
    dates = {}
    # Original Issues reflect actual submission time, not approval or impact date.
    prefix = 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '/issues/'
    for path in sorted((ROOT / 'intake').glob('*.json')):
        mapping = json.loads(path.read_text())
        issue_url = mapping.get('issue_url', '')
        if mapping.get('id') in catalog['impacts'] and issue_url.startswith(prefix) and issue_url[len(prefix):].isdigit():
            dates[mapping['id']] = github.call('GET', 'issues/' + issue_url[len(prefix):])['created_at']
    payload = snapshot(catalog, github, dates)
    # Manually committed records have no Issue/PR: use the first addition on main.
    for identifier in catalog['impacts']:
        if identifier not in payload['p_submitted_at']:
            history = subprocess.check_output(['git', 'log', '--first-parent', '--diff-filter=A', '--format=%cI', '--',
                str(ROOT / 'impacts' / (identifier + '.json'))], text=True).strip().splitlines()
            if history:
                payload['p_submitted_at'][identifier] = history[-1]
    request = Request(url + '/rest/v1/rpc/sync_github_reactions',
                      data=json.dumps(payload).encode(), method='POST', headers={
                          'apikey': key, 'Authorization': 'Bearer ' + key,
                          'Content-Type': 'application/json'})
    # Collect every GitHub page before replacing the snapshot. Any failure leaves
    # the prior snapshot intact. Never write user/reaction data into site artifacts.
    with urlopen(request, timeout=60) as response:
        response.read()
    print('Voting catalog and GitHub reactions synchronized.')


if __name__ == '__main__':
    main()
