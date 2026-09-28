export const requiredQuestions = [
  'Is the AI system described accurately, with sources supporting the claims?',
  'Do sources support a realized benefit to multiple people, including claimed numbers and improvements?',
  'Does this avoid duplicating an existing entry?',
  'Have automated validation checks passed? Approve workflow execution if GitHub requests it.'
];
export const updateQuestion = 'Are the changes justified and unrelated accepted details preserved?';
const statusContext = 'Moderator review';

export function missingReview(body, isUpdate = false) {
  // Ignore examples in code fences and hidden comments. Removing the list cannot pass review.
  const text = (body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '');
  const section = text.split(/^## Moderator review\s*$/m)[1]?.split(/^#{1,2}\s/m)[0] || '';
  const rows = [...section.matchAll(/^\s*- \[([ xX])\] (.+?)\s*$/gm)];
  const questions = isUpdate ? [...requiredQuestions, updateQuestion] : requiredQuestions;
  return questions.filter(question => {
    const matches = rows.filter(row => row[2].replace('an existing Impact?', 'an existing entry?') === question);
    return matches.length !== 1 || matches[0][1].toLowerCase() !== 'x';
  });
}

export async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request.number;
  // Every delivery checks the current body. Rapid checkbox clicks can arrive out of order.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
    if (pr.state !== 'open') return;
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
    const entryFiles = files.filter(file => [file.filename, file.previous_filename].some(name => /^data\/impacts\/[^/]+\.json$/.test(name || '')));
    const isUpdate = entryFiles.some(file => file.status !== 'added');
    const missing = entryFiles.length ? missingReview(pr.body, isUpdate) : [];
    const { data: latest } = await github.rest.pulls.get({ owner, repo, pull_number });
    if (latest.head.sha !== pr.head.sha || latest.body !== pr.body || latest.state !== pr.state) continue;
    const description = missing.length ? `${missing.length} required review box(es) still unchecked or missing` :
      entryFiles.length ? 'All required moderator review boxes checked' : 'No entry changes to review';
    await github.rest.repos.createCommitStatus({ owner, repo, sha: pr.head.sha, context: statusContext,
      state: missing.length ? 'failure' : 'success', description });
    if (missing.length) core.setFailed('Complete the Moderator review checklist before merging:\n' + missing.join('\n'));
    return;
  }
  throw new Error('Checklist is still being edited. The next delivery will verify it.');
}
