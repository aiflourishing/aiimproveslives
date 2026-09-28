# Website submissions

The Submit form creates a GitHub PR directly through `submit-impact`. No Issue is created. Sign-in is required for submission; the PR is reviewed by a moderator before merging and publishing.

## Deployment

1. Apply migrations `002_submissions.sql` and `008_direct_pr_submissions.sql` after the voting database setup. Apply `009_remove_submission_limits.sql` to remove the submission waiting period and daily cap. Migration 008 preserves old Issue receipts and adds a private PR number and service-only completion function.
2. Scope a fine-grained GitHub token to **only aiflourishing/aiimproveslives** with **Contents: Read and write**, **Pull requests: Read and write**, **Commit statuses: Read and write**, and **Issues: Read** (to resolve older receipts). Store it as the Supabase secret `GITHUB_SUBMISSIONS_TOKEN`. An existing deployment can expand its current token permissions and keep the `GITHUB_ISSUES_TOKEN` secret name; both handlers accept it for compatibility. Never put privileged tokens in the repository or browser.
3. Preserve `GITHUB_REPOSITORY=aiflourishing/aiimproveslives` and `ALLOWED_ORIGINS` for localhost and the production origins. Hosted Supabase provides its own `SUPABASE_URL` and service role key.
4. Deploy `submit-impact` and `review-checklist` with the Supabase CLI:

   ```sh
   npx supabase functions deploy submit-impact --project-ref uwmmspxcmblslchqpuvg --use-api
   npx supabase functions deploy review-checklist --project-ref uwmmspxcmblslchqpuvg --use-api
   ```

5. Set a random `GITHUB_WEBHOOK_SECRET` in Supabase and configure a repository webhook for `pull_request` events, JSON payloads, and that same secret, pointing to `https://uwmmspxcmblslchqpuvg.supabase.co/functions/v1/review-checklist`. Leave HTTPS verification enabled. The handler rejects invalid signatures and repositories, fetches the current PR and changed files, and writes the same required **Moderator review** commit status. GitHub Actions provides a fallback using trusted main code without a checkout. Both re-read the current body during rapid edits and never post a delayed pending status over a completed check.
6. Keep `Moderator review` and validation required for merges, including administrators. Preserve existing Auth callback URLs and providers. The function's gateway JWT check is disabled because submission bearer tokens are checked directly with Auth; the webhook uses HMAC signature verification instead.

## Behavior

Receipts remain private and bind a submission ID and payload hash to its verified account. Per-account locks serialize receipt creation; submissions have no waiting period or daily cap. The server uses a deterministic branch and entry ID, writes only the validated JSON file, and loads the checklist from trusted main. It rejects IDs that would overwrite accepted entries.

After creation, the thank-you message links directly to the PR. Repeating a submission returns the same receipt and PR. Accepted drafts are cleared from tab-local storage; unconfirmed drafts remain saved. Legacy receipts still resolve their old Issue/PR links. Existing GitHub reactions continue to come from the earliest merged PR that added the entry; scoring does not change.

The callback avoids Actions runner startup delays; delivery and API response time still apply. Actions reruns use the latest body, not the original event's stale checklist. The callback never executes contributed code. Failed deliveries appear in GitHub's webhook history and the Actions fallback can be rerun.

## Uncertain requests

If GitHub accepts a PR before a timeout or receipt save failure, a later GET recovers its PR number from the deterministic branch without creating another PR. If no PR was created, the pending receipt prevents blind retries. A moderator can inspect `codex/submission-RECEIPT_UUID` and PRs with `<!-- website-submission:RECEIPT_UUID -->`. Record a found PR with `public.finish_pr_submission(USER_UUID, RECEIPT_UUID, PR_NUMBER)`. Only after confirming that no PR exists and the request has finished, mark the receipt failed with a null PR number. Retrying reuses and verifies any existing branch instead of overwriting it.

## Verification

`npm test` verifies database grants, private receipts, consecutive submissions without a daily cap, direct PR creation, duplicate retries, accepted timeouts, existing-ID protection, signed webhook delivery, forged signatures, and rapid checklist edits. Python tests validate the catalog and static site. Test deployment using a real source-supported entry; do not publish fabricated entries.
