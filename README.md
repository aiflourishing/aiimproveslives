# AI Improves Lives

A community-maintained collection of examples of AI improving people's lives.

See [goals.md](goals.md) for the purpose and [todos.md](todos.md) for next steps.

[Entry criteria](entry-criteria.md) defines what qualifies. [CONTRIBUTING.md](CONTRIBUTING.md) describes the fields, Issue intake, human review, and updates.

Impacts live in `data/impacts/` as one JSON file per record. Validate with `python3 scripts/catalog.py validate`; run tests with `python3 -m unittest discover -s tests`. GitHub Actions runs both on PRs. Website styles and browser interactions live in `src/`.

Website submissions create PRs directly through ordinary code. Legacy `/update` comments remain supported on existing submission Issues. Merged records build into a static website artifact; the production publishing workflow validates the site before deployment. The submission endpoint is active.

## Website

Build with `python3 -m scripts.build_site`, then preview with `python3 -m http.server 8000 --directory dist` at http://localhost:8000. The generated `dist/` folder is ready for GitHub Pages, including repository subpaths; browsing needs no application server; reactions use Supabase. The Supabase browser SDK is vendored and version-pinned. The build workflow uploads the `website` artifact and deploys GitHub Pages after Python, JavaScript, and database checks pass.

Top sorts all matching impacts by accumulated website + GitHub reaction scores. There is no year filter. Equal scores put later submissions first. New is ordered by the first Git commit adding each Impact (with the recorded impact date as fallback for uncommitted files); full Git history is fetched in the build workflow. Cards omit dates. Detail pages show `occurred_by` at the bottom as “Reported as of”.

Search matches impact titles and full descriptions in the browser. Cards show the first 140 description characters plus `...` when longer. Every impact has a generated page that works on direct visits and reloads. Records without images receive a quiet decorative placeholder on cards; detail pages omit the image. Empty collections do not include invented content.

## Community voting

See [voting setup](supabase/README.md) to configure Google/GitHub sign-in, the private database, and hourly GitHub reaction sync. The current project has sign-in configured; new deployments need their own public configuration and server secrets. The preview never stores pretend votes.

Run `npm ci && npm test` for database permission and scoring tests against PostgreSQL WASM. These are development-only dependencies. The Python tests also cover GitHub sync and static pages.

## Website contributions

The Submit page uses the existing Google/GitHub sign-in and a Supabase Edge Function to create a PR directly for human review. No Issue is created. The endpoint allows the production domains, GitHub Pages, and localhost. See [contribution endpoint setup](supabase/CONTRIBUTIONS.md) for redeployment and configuration. Sign-in is prompted when submitting a contribution or clicking a reaction; the site name links home.

Edit the About post in `src/about.html`: one title and ordinary paragraphs, with layout handled by the stylesheet. Run `python3 -m scripts.build_site` to refresh the preview after editing.

## Editing the contribution page

Edit `src/contribute-copy.md` for the visible wording: headings, introduction, labels, hints, placeholders, buttons, and form status messages. Change the text below the labeled headings; no HTML needed. Layout lives in `src/contribute.html` and `src/styles.css`. Never edit generated files in `dist/`.

Run `python3 -m scripts.preview` for a local preview that rebuilds when source files change. Or run `python3 -m scripts.preview --github` to show the accepted catalog from GitHub's `main` while using your local page copy and styles. Both use port 8000 by default; add `--port 8001` to use a different port. Stop the old static server first if it occupies that port.

The GitHub mode polls every 60 seconds in a disposable mirror. It never pulls into, resets, or overwrites your working checkout. The homepage refreshes automatically when a new build is ready; Contribute is not reloaded while someone is filling it in. An unavailable or invalid remote catalog leaves the last working preview intact.

## Publishing approved impacts

Acceptance means **merging** the reviewed PR into `main`; an approval review by itself does not publish. The build reads the merged `data/impacts/*.json` records, produces cards in New and individual detail pages, and orders New by the first commit introducing each record on main's first-parent history. Later corrections do not bump an old entry to the top. Source links remain an array in Issue JSON, the committed record, and the generated catalog, and appear as individual links on detail pages.

Every push to `main`, including merged impact PRs, validates, builds, and deploys the site. GitHub Pages uses **GitHub Actions**, with **PAGES_ENABLED=true**. The public fallback address is https://aiflourishing.github.io/aiimproveslives/. The primary domain is `aiimproveslives.com`; `lasteval.com` redirects to it over HTTPS. Both domains require valid certificates; GitHub Pages must have HTTPS enforcement enabled.

GitHub reactions are imported hourly and when accepted records or intake mappings change. Website reactions persist immediately in Supabase and require a verified signed-in account; they are combined with GitHub reactions for ranking, rather than posted back to GitHub. Contributions create review Issues and PRs; merge the reviewed PR to publish the entry.
