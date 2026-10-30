/*
 * Copyright The Microcks Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Prow-style slash commands for issue and PR triage, run by
// .github/workflows/triage-commands.yml. Only the comment text is read;
// no pull request code is ever checked out or executed.

const DOCS_URL = 'https://github.com/microcks/microcks-cli/blob/master/documentation/triage-commands.md';

const NEEDS_TRIAGE = 'needs-triage';
const TRIAGE_ACCEPTED = 'triage/accepted';

// Command argument -> repository label. Only these labels can be set.
const TRIAGE = {
  accepted: TRIAGE_ACCEPTED,
  'needs-information': 'triage/needs-information',
};
const KIND = {
  bug: 'kind/bug',
  feature: 'kind/feature',
  enhancement: 'kind/enhancement',
  task: 'kind/task',
  question: 'kind/question',
};
const AREA = {
  cli: 'component/cli',
  connectors: 'component/connectors',
  build: 'component/build',
  docs: 'component/documentation',
  packaging: 'component/packaging',
};
const PLATFORM = {
  windows: 'platform/windows',
  linux: 'platform/linux',
  macos: 'platform/macos',
};
const FLAGS = {
  help: 'help wanted',
  'good-first-issue': 'good first issue',
  'keep-open': 'keep-open',
};

const MAINTAINER_PERMISSIONS = ['admin', 'maintain', 'write'];
const MAX_COMMANDS = 10;

/**
 * Extracts slash commands from a comment body. Commands must start a line;
 * lines inside fenced code blocks and quoted lines ("> /kind bug") are
 * ignored so that quoting a previous comment does not re-run it.
 */
function parseCommands(body) {
  const commands = [];
  let inFence = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith('/')) {
      continue;
    }
    const [head, ...args] = line.split(/\s+/);
    const name = head.slice(1).toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(name)) {
      continue;
    }
    commands.push({ name, args: args.map((a) => a.replace(/^@/, '')).filter(Boolean) });
    if (commands.length >= MAX_COMMANDS) {
      break;
    }
  }
  return commands;
}

/**
 * Turns parsed commands into the changes to apply. Pure function so it can be
 * unit tested without the GitHub API.
 *
 * ctx: { commenter, author, isMaintainer, isPullRequest, labels, assignees, state }
 * returns: { addLabels, removeLabels, assign, unassign, state, errors }
 */
function plan(commands, ctx) {
  const labels = new Set(ctx.labels);
  const out = { addLabels: [], removeLabels: [], assign: [], unassign: [], state: null, errors: [] };

  const add = (label) => {
    if (!labels.has(label)) {
      labels.add(label);
      out.addLabels.push(label);
    }
    out.removeLabels = out.removeLabels.filter((l) => l !== label);
  };
  const remove = (label) => {
    if (labels.has(label)) {
      labels.delete(label);
      out.removeLabels.push(label);
    }
    out.addLabels = out.addLabels.filter((l) => l !== label);
  };
  const needMaintainer = (cmd) => {
    if (!ctx.isMaintainer) {
      out.errors.push(`\`/${cmd}\` can only be used by maintainers.`);
      return false;
    }
    return true;
  };
  const mapped = (cmd, table, arg) => {
    const label = table[String(arg || '').toLowerCase()];
    if (!label) {
      out.errors.push(`\`/${cmd}\` expects one of: ${Object.keys(table).map((k) => `\`${k}\``).join(', ')}.`);
    }
    return label;
  };
  const labelCommand = (name, table, args) => {
    const removing = name.startsWith('remove-');
    const base = removing ? name.slice('remove-'.length) : name;
    if (!needMaintainer(name)) return;
    if (args.length === 0) {
      out.errors.push(`\`/${name}\` expects one of: ${Object.keys(table).map((k) => `\`${k}\``).join(', ')}.`);
      return;
    }
    for (const arg of args) {
      const label = mapped(base, table, arg);
      if (label) (removing ? remove : add)(label);
    }
  };

  for (const { name, args } of commands) {
    switch (name) {
      case 'triage': {
        if (!needMaintainer(name)) break;
        const label = mapped(name, TRIAGE, args[0]);
        if (!label) break;
        for (const l of Object.values(TRIAGE)) if (l !== label) remove(l);
        remove(NEEDS_TRIAGE);
        add(label);
        break;
      }
      case 'remove-triage':
        if (!needMaintainer(name)) break;
        for (const l of Object.values(TRIAGE)) remove(l);
        add(NEEDS_TRIAGE);
        break;
      case 'kind':
      case 'remove-kind':
        labelCommand(name, KIND, args);
        break;
      case 'area':
      case 'remove-area':
        labelCommand(name, AREA, args);
        break;
      case 'platform':
      case 'remove-platform':
        labelCommand(name, PLATFORM, args);
        break;
      case 'help':
      case 'good-first-issue':
      case 'keep-open': {
        if (!needMaintainer(name)) break;
        if (name !== 'keep-open' && !ctx.isPullRequest && !labels.has(TRIAGE_ACCEPTED)) {
          out.errors.push(`\`/${name}\` needs the issue to be accepted first: use \`/triage accepted\`.`);
          break;
        }
        add(FLAGS[name]);
        break;
      }
      case 'remove-help':
      case 'remove-good-first-issue':
      case 'remove-keep-open':
        if (!needMaintainer(name)) break;
        remove(FLAGS[name.slice('remove-'.length)]);
        break;
      case 'assign': {
        const targets = args.length ? args : [ctx.commenter];
        const others = targets.filter((u) => u.toLowerCase() !== ctx.commenter.toLowerCase());
        if (others.length && !ctx.isMaintainer) {
          out.errors.push('Only maintainers can assign other people. Use `/assign` on its own to assign yourself.');
          break;
        }
        if (!ctx.isMaintainer && !ctx.isPullRequest && !labels.has(TRIAGE_ACCEPTED)) {
          out.errors.push('This issue has not been accepted yet. A maintainer will triage it first; please wait for the `triage/accepted` label before picking it up.');
          break;
        }
        if (!ctx.isMaintainer && ctx.isPullRequest) {
          out.errors.push('Only maintainers can assign pull requests.');
          break;
        }
        out.assign.push(...targets);
        break;
      }
      case 'unassign': {
        const targets = args.length ? args : [ctx.commenter];
        const others = targets.filter((u) => u.toLowerCase() !== ctx.commenter.toLowerCase());
        if (others.length && !ctx.isMaintainer) {
          out.errors.push('Only maintainers can unassign other people. Use `/unassign` on its own to unassign yourself.');
          break;
        }
        out.unassign.push(...targets);
        break;
      }
      case 'close':
      case 'reopen': {
        const isAuthor = ctx.author && ctx.author.toLowerCase() === ctx.commenter.toLowerCase();
        if (!ctx.isMaintainer && !isAuthor) {
          out.errors.push(`\`/${name}\` can only be used by maintainers or the author.`);
          break;
        }
        out.state = name === 'close' ? 'closed' : 'open';
        break;
      }
      default:
        // Unknown commands are ignored, like Prow does, so "/path/to/file"
        // or other text starting with a slash does not trigger a reply.
        break;
    }
  }
  return out;
}

async function isMaintainer(github, owner, repo, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return MAINTAINER_PERMISSIONS.includes(data.permission);
  } catch (err) {
    // 404 means the user is not a collaborator.
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Entry point called from actions/github-script.
 */
async function run({ github, context, core }) {
  const { comment, issue } = context.payload;
  if (!comment || !issue || comment.user.type === 'Bot') return;

  const commands = parseCommands(comment.body);
  if (commands.length === 0) return;

  const { owner, repo } = context.repo;
  const issue_number = issue.number;
  const commenter = comment.user.login;

  const result = plan(commands, {
    commenter,
    author: issue.user && issue.user.login,
    isMaintainer: await isMaintainer(github, owner, repo, commenter),
    isPullRequest: Boolean(issue.pull_request),
    labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: (issue.assignees || []).map((a) => a.login),
  });

  const failures = [...result.errors];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      core.warning(`${what}: ${err.message}`);
      failures.push(`Could not ${what}: ${err.message}`);
    }
  };

  for (const name of result.removeLabels) {
    await attempt(`remove label \`${name}\``, () => github.rest.issues.removeLabel({ owner, repo, issue_number, name }));
  }
  if (result.addLabels.length) {
    await attempt(`add ${result.addLabels.map((l) => `\`${l}\``).join(', ')}`, () =>
      github.rest.issues.addLabels({ owner, repo, issue_number, labels: result.addLabels }));
  }
  if (result.unassign.length) {
    await attempt('unassign', () => github.rest.issues.removeAssignees({ owner, repo, issue_number, assignees: result.unassign }));
  }
  if (result.assign.length) {
    await attempt('assign', async () => {
      const { data } = await github.rest.issues.addAssignees({ owner, repo, issue_number, assignees: result.assign });
      const assigned = new Set((data.assignees || []).map((a) => a.login.toLowerCase()));
      const missing = result.assign.filter((u) => !assigned.has(u.toLowerCase()));
      if (missing.length) {
        throw new Error(`${missing.map((u) => `@${u}`).join(', ')} cannot be assigned. They need to comment on this issue first.`);
      }
    });
  }
  if (result.state) {
    await attempt(result.state === 'closed' ? 'close' : 'reopen', () =>
      github.rest.issues.update({ owner, repo, issue_number, state: result.state }));
  }

  const changed = result.addLabels.length || result.removeLabels.length || result.assign.length
    || result.unassign.length || result.state;
  if (changed && failures.length === 0) {
    await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: comment.id, content: '+1' });
  }
  if (failures.length) {
    await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: comment.id, content: 'confused' });
    const lines = failures.map((f) => `- ${f}`).join('\n');
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: `@${commenter} thanks! Some commands were not applied:\n\n${lines}\n\nSee the [triage commands](${DOCS_URL}) for details.`,
    });
  }
}

/**
 * Adds needs-triage to newly opened issues, unless a maintainer already
 * triaged them through a label.
 */
async function labelNewIssue({ github, context }) {
  const { issue } = context.payload;
  if (!issue) return;
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  if (labels.some((l) => l.startsWith('triage/'))) return;
  await github.rest.issues.addLabels({
    ...context.repo,
    issue_number: issue.number,
    labels: [NEEDS_TRIAGE],
  });
}

module.exports = { run, labelNewIssue, parseCommands, plan };
