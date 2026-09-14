# Submit an Impact or project Profile

Read the [acceptance criteria](entry-criteria.md), then open an [Impact or Profile Issue](https://github.com/aiflourishing/aiimproveslives/issues/new/choose). Fill in the JSON and contributor answer. No local tools are needed.

Code validates the submission and opens a linked PR containing the record. Invalid submissions get an error comment; edit the Issue to retry. A moderator approves and merges the PR. Keep the Issue open for future updates.

Submit a new Profile first and wait for acceptance before submitting an Impact that references it. Impact IDs are generated automatically; Profile IDs are chosen by contributors.

## Profile

Use this structure in the Profile Issue form; acceptance creates `data/profiles/<id>.json`:

```json
{
  "id": "example-project",
  "name": "Example Project",
  "types": ["research", "system"],
  "description": "An objective description of what the project does.",
  "url": "https://example.org"
}
```

IDs are unique, lowercase words separated by hyphens, and stay unchanged after acceptance. Choose one or more types: `research`, `model`, `system`, `product`, `dataset`. `url` is the official or primary reference page.

Profiles also accept optional `sources` (a nonempty list of supporting HTTP(S) URLs) and `contributors` (a list of names). Intake names can be comma-separated; store them as separate list items, preserving spaces within names.

Both Issue forms ask **Are you one of the contributor(s)?** The answer is stored as `submitter_is_contributor` (`true` or `false`): for a Profile, answer about the project; for an Impact, answer about that Impact. This is the original submitter's self-report, not verified status. Preserve it in updates unless correcting the original answer.

## Impact

Omit `id` in the initial Issue submission. Automation assigns a stable UUID and filename. Include the accepted ID unchanged in updates.

| Field | Content |
| --- | --- |
| `id` | Generated UUID |
| `profile_id` | `@profile-id`; must exist or be added in the same PR |
| `title` | Short description of the improvement |
| `description` | What the project does, how many people benefited, and what improved in their lives. Support claims with source URLs. Say when numbers are unknown. |
| `sources` | At least one HTTP(S) source URL, stored as a list |
| `submitter_is_contributor` | Required `true` or `false`: are you one of the contributor(s) to this Impact? |
| `contributors` | Optional list of names; intake also accepts a comma-separated string and trims only surrounding whitespace |
| `cites` | Optional list of work this Impact benefited from: `@profile-id` references or plain names |
| `image` | Optional direct HTTPS image URL |

Example optional fields:

```json
{
  "contributors": ["Jane Doe", "Alex Smith"],
  "cites": ["@example-project", "Work without a Profile"],
  "image": "https://example.org/photo.jpg"
}
```

Profiles also accept `image`. Link the image itself, not its hosting page; only submit images you have permission to publish. Missing or unavailable images will use a default when the website is built. Image availability and source evidence are reviewed by humans; validation checks URL structure only.

Required text must be nonempty. Omit unused optional fields. Profile references must resolve; a Profile's Impacts are derived from `profile_id` rather than stored twice.

## Review and updates

When realized impact changes significantly, at contributor and moderator discretion, post a comment on the original Issue in this format. Corrections are welcome anytime; there is no fixed schedule.

````text
/update
```json
{
  "id": "project-id",
  "name": "Project name",
  "types": ["system"],
  "description": "Updated, source-supported description.",
  "url": "https://example.org",
  "sources": ["https://example.org/new-evidence"],
  "submitter_is_contributor": false
}
```
````

Copy the **complete current record** from `data/`, then edit it. This example is a Profile; Impacts use their own fields. Keep the ID and unrelated fields unchanged. Omitted optional fields are removed. Include supporting source URLs and confirm permission for any new image in the comment.

Automation opens a new linked PR; moderators review the exact changes using the PR checklist. Anyone may propose an update; no comment grants approval or changes accepted content. Ordinary discussion comments are ignored. One PR per Issue can be pending at a time: merge or close it before submitting another proposal. To correct a pending proposal, close its PR and edit the submission with the corrected JSON.

An accepted Issue can update only its own record. Expand an existing Impact when reach or results change; open a new Impact Issue for a distinct benefit.

## Repository setup

After these files reach the default branch:

- Enable Issues and Actions, and enable **Allow GitHub Actions to create and approve pull requests** in Actions settings. The workflow only creates PRs; it never approves or merges them.
- Require human approval and the `validate` check on `main`; dismiss stale approvals when commits change. Assign moderators with permission to review and merge.
- GitHub may ask a moderator to **Approve workflows to run** on bot-created PRs. Approve execution, then wait for validation before merging. No additional token is needed.

The intake workflow runs trusted code from the default branch. Submitted text is parsed as data, never executed, and only record/mapping files are written to proposal branches. There are no LLM calls.

After merge, the catalog workflow validates records and uploads `catalog.json` as an Actions artifact. This is ready for a future website build, but is not yet a public API or deployed website.

Local checks (Python 3.9+, no dependencies):

```sh
python3 -m unittest discover -s tests
python3 scripts/catalog.py validate
python3 -m scripts.build_catalog
```

For manual record creation, `python3 scripts/catalog.py new-impact @profile-id` remains available. Issue associations live separately in `data/intake/` and are committed with initial submissions.
