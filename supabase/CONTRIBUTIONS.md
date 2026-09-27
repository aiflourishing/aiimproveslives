# Website contributions

The Contribute form and deployed `submit-impact` function create GitHub Issues, which the live intake workflow turns into PRs for human review. This path has been verified with a real submission. Sign-in appears when submitting or reacting; there is no account button in the navigation or contribution form.

## Setup for a new project or redeployment

1. If it has not already been applied, run `migrations/002_submissions.sql` in this project's Supabase SQL Editor, after `001_reactions.sql`. It creates a private receipt table and three service-only functions. Do not expose the private schema.
2. Create a **fine-grained GitHub personal access token**, owned by an account with access to `aiflourishing/aiimproveslives`. Select **only that repository** and **Issues: Read and write**. Store it as the Supabase Edge Function secret `GITHUB_ISSUES_TOKEN`. Use a personal access token, not a GitHub App token: the existing intake intentionally ignores bot senders. Do not store the token in the browser, repository, chat, or public configuration. Set an expiry and renew it before expiry.
3. Set Edge Function secrets `GITHUB_REPOSITORY=aiflourishing/aiimproveslives` and `ALLOWED_ORIGINS=http://localhost:8000`. `SUPABASE_URL` and the legacy `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase's hosted function environment. No privileged key goes into `src/voting-config.json`.
4. Deploy from the repository root with the Supabase CLI:

   ```sh
   npx supabase login
   npx supabase functions deploy submit-impact --project-ref uwmmspxcmblslchqpuvg --use-api
   ```

   `supabase/config.toml` disables the legacy gateway JWT check for this function because the handler verifies every bearer token directly with Supabase Auth. It rejects anonymous and unverified users before accessing receipts or GitHub. CORS permits only configured origins; it is not the authentication mechanism.
5. Ensure the current Issue template, `scripts/intake.py`, and intake workflow are on GitHub's default branch. Local files alone do not update GitHub Actions. If the repository checkbox is disabled, first allow it in the organization’s Actions settings. In the repository's Actions settings enable **Allow GitHub Actions to create and approve pull requests**. The workflow only creates PRs; it never approves or merges them. Keep human approval and validation required.
6. Keep `http://localhost:8000/index.html` allowed in Supabase Auth's redirect URLs. This single callback returns people to the page that requested sign-in using session storage. The existing Google/GitHub providers are reused.
7. Set `submissionsEnabled` to `true` in `src/voting-config.json` once the deployed endpoint is configured. Rebuild with `python3 -m scripts.build_site`. Sign in at `/contribute/`, submit a real source-supported impact, and verify the returned Issue and PR. Confirm the private receipt exists and a repeat of the same submission returns the same Issue. Do not publish fabricated test impacts.

Later, add the actual production origin to `ALLOWED_ORIGINS` and the production `/index.html` callback to Supabase Auth when deploying the website. Public domain hosting is separate from this endpoint.

## Submission behavior

The function validates all fields and attributes the public Issue to a signed-in website contributor without publishing their account ID or email. GitHub shows the token owner's account as the Issue author. Receipts associate submissions with a private Supabase user ID.

A per-account database lock enforces one new submission per minute and at most ten receipt rows per day. Identical content from the same account reuses the existing receipt, including across page reloads; different content cannot reuse an existing submission identifier. Definitively rejected GitHub requests can be retried after the cooldown. Failed-receipt retries also count toward the per-minute cooldown. The form retains its draft in local storage on the current browser, including before sign-in, and does not resubmit automatically after sign-in.

After GitHub accepts the Issue, the page shows a thank-you message with “review” linked to the Issue. It checks trusted bot comments in the background and replaces that link with the PR URL when available. There are no status or “contribute another” buttons. Accepted drafts are cleared from browser storage, so revisiting Contribute opens a fresh form. Unconfirmed submissions retain their draft. Merging the reviewed PR publishes the record to the catalog.

## Rare uncertain requests

If GitHub times out after possibly accepting the Issue, the receipt stays `pending`; repeating the POST cannot create another Issue. A moderator should look for `<!-- website-submission:RECEIPT_UUID -->` in recent repository Issues. If found, record the corresponding Issue number using `public.finish_submission(USER_UUID, RECEIPT_UUID, ISSUE_NUMBER)` from the SQL Editor. If confirmed absent after checking recent Issues and allowing for the in-flight request to complete, mark it failed with a null Issue number so the contributor can retry. Never mark an uncertain receipt failed without checking GitHub first. The same recovery applies if saving the Issue number fails after GitHub accepts it.

## Checks

`npm test` tests the real receipt migration using PostgreSQL WASM and exercises the function with mocked Auth/GitHub responses, including duplicates, timeout uncertainty, cross-user isolation, permissions, and limits. It also passes the generated Issue body into the real Python intake parser. `python3 -m unittest discover -s tests` covers static pages and existing intake behavior. Repeat the hosted end-to-end check after changes to deployment or credentials.
