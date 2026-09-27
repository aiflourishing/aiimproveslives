"""Build the validated catalog consumed by the website."""

import json
from pathlib import Path

from scripts.catalog import ROOT, load_catalog


def build(root=ROOT, output=Path('dist/catalog.json')):
    catalog = load_catalog(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return output


if __name__ == '__main__':
    print(build())
