"""Deterministic Issue/JSON intake. Never evaluates contributor text as code."""

import hashlib
from urllib.parse import quote
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from scripts.catalog import load_catalog


def json_object(text):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    result = json.loads(text, object_pairs_hook=unique_keys)
    if not isinstance(result, dict):
        raise ValueError("Submit one JSON object.")
    return result


def fenced_json(body):
    blocks = re.findall(r"^```json\s*\n(.*?)\n```\s*$", body, re.M | re.S)
    if len(blocks) != 1:
        raise ValueError("Include exactly one fenced JSON block (```json).")
    return json_object(blocks[0])


def parse_submission(event, root):
    """Return (record path, record, Issue mapping) without changing the catalog."""
    issue = event["issue"]
    number = issue["number"]
    mapping_path = root / "intake" / f"{number}.json"
    mapping = json.loads(mapping_path.read_text()) if mapping_path.exists() else None
    comment = event.get("comment")
    if comment:
        if not mapping:
            raise ValueError("Wait for the initial submission PR to merge before updating.")
        record = fenced_json(comment["body"])
        identifier = mapping["id"]
        if record.get("id") != identifier:
            raise ValueError("Keep the accepted record's id unchanged.")
    else:
        if mapping:
            raise ValueError("This record is accepted. Post /update with its full updated JSON.")
        body = issue.get("body") or ""
        headings = re.findall(r"^### Impact JSON$", body, re.M)
        if len(headings) != 1:
            raise ValueError("Use the Impact Issue form.")
        record = fenced_json(body)
        answer = re.search(r"^### Are you one of the contributor\(s\)\?\s*\n\s*(Yes|No)\s*(?:\n|$)", body, re.M)
        if not answer:
            raise ValueError("Answer 'Are you one of the contributor(s)?' with Yes or No.")
        record["submitter_is_contributor"] = answer[1] == "Yes"
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, issue["html_url"]))
        if "id" in record and record["id"] != identifier:
            raise ValueError("Omit id for a new Impact; it is generated automatically.")
        record["id"] = identifier
        mapping = {"id": identifier, "issue_url": issue["html_url"]}

    # Validate before constructing a filesystem path.
    try:
        if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
            raise ValueError
    except ValueError:
        raise ValueError("Invalid Impact id.") from None
    relative = Path("impacts") / f"{identifier}.json"
    existing = root / relative
    if not comment and existing.exists():
        raise ValueError("That id already exists. Use the record's original Issue for updates.")
    if comment and not existing.exists():
        raise ValueError("The accepted record is missing; ask a moderator to investigate.")
    if comment and record == json.loads(existing.read_text()):
        raise ValueError("No changes to the accepted record.")
    with tempfile.TemporaryDirectory() as directory:
        staged = Path(directory) / "data"
        shutil.copytree(root, staged)
        target = staged / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(record), encoding="utf-8")
        load_catalog(staged)
    return relative, record, mapping


class GitHub:
    def __init__(self, repo):
        self.prefix = f"repos/{repo}"

    def call(self, method, path, payload=None):
        args = ["gh", "api", "--method", method, f"{self.prefix}/{path}"]
        if payload is not None:
            args += ["--input", "-"]
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def pages(self, path):
        for page in range(1, 1001):
            separator = "&" if "?" in path else "?"
            rows = self.call("GET", f"{path}{separator}per_page=100&page={page}")
            yield from rows
            if len(rows) < 100:
                return
        raise RuntimeError("Pagination limit exceeded.")

    def comment_once(self, number, text):
        marker = "<!-- intake:" + hashlib.sha256(text.encode()).hexdigest() + " -->"
        if not any(marker in (comment.get("body") or "") and comment["user"]["type"] == "Bot"
                   for comment in self.pages(f"issues/{number}/comments")):
            self.call("POST", f"issues/{number}/comments", {"body": text + "\n\n" + marker})


def process(event, root, api):
    issue = event.get("issue", {})
    if "pull_request" in issue or event.get("sender", {}).get("type") == "Bot":
        return
    comment = event.get("comment")
    body = (comment or issue).get("body") or ""
    if comment:
        if body.splitlines()[:1] != ["/update"]:
            return
    elif not re.search(r"^### Impact JSON$", body, re.M):
        return
    number = issue["number"]
    try:
        relative, record, mapping = parse_submission(event, root)
    except ValueError as exc:
        api.comment_once(number, f"Submission needs changes:\n\n{exc}")
        return

    prefix = f"codex/intake-{number}-"
    digest = hashlib.sha256((str((comment or issue)["id"]) + body).encode()).hexdigest()[:16]
    branch = prefix + digest
    owner = event["repository"]["owner"]["login"]
    previous = api.call("GET", f"pulls?state=all&head={owner}:{branch}")
    if previous:
        api.comment_once(number, f"Submission PR: {previous[0]['html_url']}")
        return
    pending = next((pr for pr in api.pages("pulls?state=open")
                    if pr["head"]["ref"].startswith(prefix)
                    and pr["head"]["repo"] and pr["head"]["repo"]["full_name"] == event["repository"]["full_name"]), None)
    if pending:
        api.comment_once(number, f"An update is already pending: {pending['html_url']}. "
                         "Merge or close it first, then edit/resubmit your submission to retry.")
        return

    # Use the exact checked-out, validated base, even if main advances during this run.
    base_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    base = api.call("GET", f"git/commits/{base_sha}")
    files = {f"data/{relative.as_posix()}": record}
    if not comment:
        files[f"data/intake/{number}.json"] = mapping
    tree = api.call("POST", "git/trees", {
        "base_tree": base["tree"]["sha"],
        "tree": [{"path": path, "mode": "100644", "type": "blob",
                  "content": json.dumps(value, indent=2, ensure_ascii=False) + "\n"}
                 for path, value in files.items()],
    })
    commit = api.call("POST", "git/commits", {
        "message": f"{'Update' if comment else 'Add'} {relative} (Issue #{number})",
        "tree": tree["sha"], "parents": [base_sha],
    })
    # Recover if a previous run created the branch but failed before opening its PR.
    refs = api.call("GET", f"git/matching-refs/heads/{branch}")
    if refs:
        sha = next(ref["object"]["sha"] for ref in refs if ref["ref"] == f"refs/heads/{branch}")
        existing_commit = api.call("GET", f"git/commits/{sha}")
        if existing_commit["tree"]["sha"] != tree["sha"]:
            raise RuntimeError("Existing intake branch differs. Close/delete it or submit a new comment.")
    else:
        api.call("POST", "git/refs", {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    source = (comment or issue)["html_url"]
    checklist = (Path(__file__).resolve().parents[1] / ".github/pull_request_template.md").read_text()
    if comment:
        checklist += "\n- [ ] Are the changes justified and unrelated accepted details preserved?\n"
    image_preview = ''
    if record.get('image'):
        # Encode Markdown delimiters so the URL cannot break out of the image.
        image_url = quote(record['image'], safe=':/?&=%+#@!$;,~*-._')
        image_preview = f"### Image preview\n\n![Submitted impact image](<{image_url}>)\n\n"
    preview = (f"## {record['title']}\n\n{record['description']}\n\n"
               f"### Impact occurred by\n\n{record['occurred_by']}\n\n### Sources\n\n"
               + '\n'.join(f"- <{quote(url, safe=':/?&=%+#@!$;,~*-._')}>" for url in record['sources']) + '\n\n')
    pr = api.call("POST", "pulls", {
        "title": f"{'Update' if comment else 'Add'} {relative} (Issue #{number})",
        "head": branch, "base": event["repository"]["default_branch"],
        "body": f"Source submission: {source}\n\nRelated Issue: #{number}\n\n"
                + preview + image_preview + checklist,
    })
    api.comment_once(number, f"Ready for moderator review: {pr['html_url']}\n\n"
                     f"Record: `data/{relative.as_posix()}`. After merge, post `/update` "
                     "followed by a fenced JSON block containing the complete updated record here.")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    api = GitHub(os.environ["GITHUB_REPOSITORY"])
    try:
        process(event, Path("data"), api)
    except (subprocess.CalledProcessError, RuntimeError) as exc:
        # Do not echo command output or credentials into a public comment.
        api.comment_once(event["issue"]["number"], "Intake automation failed. A moderator should inspect "
                         "the Actions run, check repository permissions, and rerun it.")
        raise
