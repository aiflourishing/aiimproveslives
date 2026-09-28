# Community voting setup

The website is static; Supabase hosts authentication and the private database. The current project allows localhost, the GitHub Pages callback, and both production domain callbacks. The steps below describe setup for a new project.

1. Create a Supabase Free project. Run `migrations/001_reactions.sql`, then `migrations/003_neutral_laugh.sql`, `migrations/004_highlight_submission_order.sql`, `migrations/005_sync_safe_updates.sql`, `migrations/006_public_vote_scores.sql`, and `migrations/007_positive_only_votes.sql`, once each in its SQL Editor. Do not expose the `private` schema through the Data API.
2. Enable Google and GitHub in Supabase Authentication → Providers. Register OAuth applications with each provider and enter their client secrets in Supabase, not this repository. Use the Supabase callback URL shown by each provider configuration. See [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google) and [GitHub setup](https://supabase.com/docs/guides/auth/social-login/auth-github).
3. In Auth URL Configuration, set the production site URL. Allow its exact `index.html` callback (including the repository subpath), plus `http://localhost:8000/index.html` for local testing. The client uses PKCE. Do not enable anonymous sign-in. Enable auth abuse controls/CAPTCHA as appropriate before public launch.
4. Put the project URL and **publishable key** in `src/voting-config.json`. This file is public. Never put the service-role key or an OAuth secret here. Rebuild the website.
5. In GitHub repository Actions settings, add variables `SUPABASE_URL` and `VOTING_ENABLED=true`, and the secret `SUPABASE_SERVICE_ROLE_KEY` (legacy server-side service-role JWT). Run “Sync community reactions” manually once. It thereafter runs hourly and when impacts change on main. GitHub schedules can be delayed; they are not a real-time guarantee. Secrets never enter the static build.
6. Smoke-test both OAuth providers on the production origin, reaction persistence after reload, a second account's inability to read another account's votes, and a removed PR reaction after sync. The local tests stub auth and cannot verify a hosted provider configuration.

Google/GitHub sign-in are the initial choices. No email/password flow or email delivery service is required.

## Scoring

Website: one active reaction per authenticated account per impact. The website offers only ❤️ (Like, +1). Stored `heart` and legacy `improved` votes count as +1 and display as a selected heart. Clicking the active heart removes the like. New negative reactions are rejected; historical `confused` votes remain stored but contribute zero. All writes derive user identity and timestamps on the server. Client-provided scores and user IDs are never accepted.

GitHub: each reaction on the **body of the earliest merged PR that added the impact JSON file** contributes independently. Comments, update PRs, unmerged PRs, and intake Issues do not contribute. If a PR originally adds several impacts, its reactions contribute to each. Directly committed impacts receive website votes but no PR contribution.

| GitHub API content | Emoji | Score |
| --- | --- | --- |
| `+1` | 👍 | +1 |
| `heart` | ❤️ | +1 |
| `hooray` | 🎉 | +1 |
| `rocket` | 🚀 | +1 |
| `eyes` | 👀 | +1 |
| `-1` | 👎 | 0 (neutral) |
| `laugh` | 😄 | 0 (neutral) |
| `confused` | 😕 | 0 (neutral) |

GitHub reactions and website votes are added together without cross-platform deduplication, as requested. A person may also add several different reactions on GitHub; each contributes. Re-running sync replaces the complete GitHub snapshot atomically, so it cannot accumulate duplicate imports, and removed reactions disappear. Failed fetches leave the old snapshot intact.

Top orders all matching impacts by accumulated score. Equal scores put later original submissions first (Issue creation time, then original PR creation time for records without an Issue; manual records use their first commit on main). Identical or missing timestamps fall back to UUID order. No minimum score or editorial boost is applied. The combined score appears beside the heart button only above 5. Top order and scores are baked into each published page from the public ranking RPC. Repeat visits use the last public snapshot immediately, and live ranking fetches start before the sign-in SDK loads. Authoritative scores refresh after voting, every 30 seconds while the page is visible, and on returning to the tab. The layout stays still while voting; rankings refresh on the next page load. Search filters the loaded ranking; no year filter applies.

## Privacy and limits

Private website rows store `user_id`, `impact_id`, `reaction`, `created_at`, and `updated_at`. Users may retrieve only their own current reactions through a function. The legacy ranking returns impact IDs in score order. The public `impact_scores()` function additionally returns combined scores only when above 5; lower scores are null. Neither function exposes voter identities or individual vote rows. GitHub rows also store GitHub user ID, reaction ID, creation time, and sync time; their source reactions remain public on GitHub. Ranking order can reveal relative popularity; this is not anonymity against all inference.

Tables have RLS enabled and no browser table permissions. Narrow security-definer functions have a fixed empty search path and explicit grants. Only the service-role sync can populate approved impact IDs or import GitHub reactions. Website vote changes have a server-enforced one-second per-account cooldown, serialized across concurrent requests.

Verified accounts, uniqueness constraints, and cooldowns prevent simple duplicate/replay abuse, not multiple-account creation or coordinated voting. This is not an “unhackable” popularity signal. At scale, cache the ordered IDs or maintain aggregate scores instead of summing all votes per page load; add monitoring and backups. Free-plan quotas and inactivity pausing still apply. Maintain private database exports; do not commit vote data to GitHub.

For an existing database that has not applied it, `migrations/003_neutral_laugh.sql` makes 😄 neutral. It replaces the ranking function without deleting reactions; previously synced laughs immediately contribute zero.

For existing databases that have not applied it, run `migrations/004_highlight_submission_order.sql`, then run the community reaction sync to backfill original submission dates. The point weights are unchanged, including neutral GitHub 😄 reactions.

Apply `005_sync_safe_updates.sql` after migration 004. It makes catalog sync compatible with Supabase safe-update checks without deleting website votes. The current project has this fix applied; GitHub sync runs after catalog merges and hourly.

Apply `006_public_vote_scores.sql` to expose the thresholded aggregate scores used by the reaction controls. It preserves all existing votes, scoring weights, ranking tie-breaks, and authentication requirements.

Apply `007_positive_only_votes.sql` after migration 006 to reject new website dislikes and make all historical website dislikes and GitHub `-1`/`confused` reactions neutral in both ranking and public scores. It preserves existing reactions, likes, the score display threshold, and ranking tie-breaks. No reaction subtracts points. The current project has this update applied.
