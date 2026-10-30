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

// Run with: node --test .github/scripts/triage-commands.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommands, plan, run, labelNewIssue } = require('./triage-commands.js');

const maintainer = { commenter: 'alice', author: 'bob', isMaintainer: true, isPullRequest: false, labels: [], assignees: [] };
const contributor = { ...maintainer, commenter: 'carol', isMaintainer: false };

test('parseCommands reads commands at the start of lines', () => {
  assert.deepEqual(parseCommands('Looks good.\n/triage accepted\n  /kind bug\n/assign @dave'), [
    { name: 'triage', args: ['accepted'] },
    { name: 'kind', args: ['bug'] },
    { name: 'assign', args: ['dave'] },
  ]);
});

test('parseCommands ignores code blocks, quotes, inline slashes and paths', () => {
  const body = [
    '```', '/close', '```',
    '> /kind bug',
    'please run `/assign`',
    'see cmd/test.go',
    '/usr/local/bin/microcks',
  ].join('\n');
  assert.deepEqual(parseCommands(body), []);
});

test('parseCommands caps the number of commands', () => {
  assert.equal(parseCommands(Array(50).fill('/kind bug').join('\n')).length, 10);
});

test('/triage accepted replaces needs-triage and other triage labels', () => {
  const r = plan(parseCommands('/triage accepted'), { ...maintainer, labels: ['needs-triage', 'triage/needs-information'] });
  assert.deepEqual(r.addLabels, ['triage/accepted']);
  assert.deepEqual(r.removeLabels.sort(), ['needs-triage', 'triage/needs-information']);
  assert.deepEqual(r.errors, []);
});

test('/remove-triage puts needs-triage back', () => {
  const r = plan(parseCommands('/remove-triage'), { ...maintainer, labels: ['triage/accepted'] });
  assert.deepEqual(r.removeLabels, ['triage/accepted']);
  assert.deepEqual(r.addLabels, ['needs-triage']);
});

test('label commands map to existing repository labels', () => {
  const r = plan(parseCommands('/kind bug\n/area docs\n/platform windows'), maintainer);
  assert.deepEqual(r.addLabels, ['kind/bug', 'component/documentation', 'platform/windows']);
});

test('/remove-kind removes only labels that are present', () => {
  const r = plan(parseCommands('/remove-kind bug\n/remove-kind task'), { ...maintainer, labels: ['kind/bug'] });
  assert.deepEqual(r.removeLabels, ['kind/bug']);
  assert.deepEqual(r.errors, []);
});

test('unknown label values are reported', () => {
  const r = plan(parseCommands('/kind nonsense\n/kind'), maintainer);
  assert.equal(r.addLabels.length, 0);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /expects one of/);
});

test('contributors cannot use maintainer commands', () => {
  const r = plan(parseCommands('/triage accepted\n/kind bug\n/keep-open\n/good-first-issue'), contributor);
  assert.equal(r.addLabels.length, 0);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0], /only be used by maintainers/);
});

test('/good-first-issue and /help need triage/accepted on issues', () => {
  const before = plan(parseCommands('/good-first-issue\n/help'), maintainer);
  assert.equal(before.addLabels.length, 0);
  assert.equal(before.errors.length, 2);

  const after = plan(parseCommands('/good-first-issue\n/help'), { ...maintainer, labels: ['triage/accepted'] });
  assert.deepEqual(after.addLabels, ['good first issue', 'help wanted']);
});

test('triaging and flagging in the same comment works', () => {
  const r = plan(parseCommands('/triage accepted\n/good-first-issue'), { ...maintainer, labels: ['needs-triage'] });
  assert.deepEqual(r.addLabels, ['triage/accepted', 'good first issue']);
  assert.deepEqual(r.errors, []);
});

test('contributors can self-assign only accepted issues', () => {
  const pending = plan(parseCommands('/assign'), contributor);
  assert.deepEqual(pending.assign, []);
  assert.match(pending.errors[0], /not been accepted yet/);

  const accepted = plan(parseCommands('/assign'), { ...contributor, labels: ['triage/accepted'] });
  assert.deepEqual(accepted.assign, ['carol']);
  assert.deepEqual(accepted.errors, []);
});

test('contributors cannot assign others or pull requests', () => {
  const others = plan(parseCommands('/assign @dave'), { ...contributor, labels: ['triage/accepted'] });
  assert.deepEqual(others.assign, []);
  assert.match(others.errors[0], /Only maintainers can assign other people/);

  const pr = plan(parseCommands('/assign'), { ...contributor, isPullRequest: true });
  assert.deepEqual(pr.assign, []);
  assert.match(pr.errors[0], /pull requests/);
});

test('maintainers can assign anyone, before triage', () => {
  const r = plan(parseCommands('/assign @dave @erin'), maintainer);
  assert.deepEqual(r.assign, ['dave', 'erin']);
});

test('anyone can unassign themselves but not others', () => {
  assert.deepEqual(plan(parseCommands('/unassign'), contributor).unassign, ['carol']);
  const r = plan(parseCommands('/unassign @dave'), contributor);
  assert.deepEqual(r.unassign, []);
  assert.equal(r.errors.length, 1);
});

test('/close and /reopen work for maintainers and the author only', () => {
  assert.equal(plan(parseCommands('/close'), maintainer).state, 'closed');
  assert.equal(plan(parseCommands('/reopen'), { ...contributor, commenter: 'bob' }).state, 'open');
  const r = plan(parseCommands('/close'), contributor);
  assert.equal(r.state, null);
  assert.equal(r.errors.length, 1);
});

test('unknown commands are ignored without errors', () => {
  const r = plan(parseCommands('/lgtm\n/approve\n/cc @dave'), contributor);
  assert.deepEqual(r, { addLabels: [], removeLabels: [], assign: [], unassign: [], state: null, errors: [] });
});

// --- run() against a fake GitHub client ---

function fakeGithub({ permission = 'read', assignable = () => true } = {}) {
  const calls = [];
  const record = (name, fn = () => ({ data: {} })) => async (args) => { calls.push([name, args]); return fn(args); };
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: record('permission', () => {
          if (permission === null) { const e = new Error('Not Found'); e.status = 404; throw e; }
          return { data: { permission } };
        }),
      },
      issues: {
        addLabels: record('addLabels'),
        removeLabel: record('removeLabel'),
        addAssignees: record('addAssignees', ({ assignees }) => ({ data: { assignees: assignees.filter(assignable).map((login) => ({ login })) } })),
        removeAssignees: record('removeAssignees'),
        update: record('update'),
        createComment: record('createComment'),
      },
      reactions: { createForIssueComment: record('reaction') },
    },
  };
  return { github, calls };
}

const core = { warning: () => {} };

function contextFor(body, { login = 'alice', type = 'User', labels = [], pr = false } = {}) {
  return {
    repo: { owner: 'microcks', repo: 'microcks-cli' },
    payload: {
      comment: { id: 99, body, user: { login, type } },
      issue: {
        number: 7,
        user: { login: 'bob' },
        labels: labels.map((name) => ({ name })),
        assignees: [],
        ...(pr ? { pull_request: {} } : {}),
      },
    },
  };
}

test('run applies maintainer commands and reacts with +1', async () => {
  const { github, calls } = fakeGithub({ permission: 'write' });
  await run({ github, context: contextFor('/triage accepted\n/kind bug', { labels: ['needs-triage'] }), core });
  const names = calls.map(([n]) => n);
  assert.deepEqual(names, ['permission', 'removeLabel', 'addLabels', 'reaction']);
  assert.deepEqual(calls[2][1].labels, ['triage/accepted', 'kind/bug']);
  assert.equal(calls[3][1].content, '+1');
});

test('run treats non-collaborators (404) as contributors and explains', async () => {
  const { github, calls } = fakeGithub({ permission: null });
  await run({ github, context: contextFor('/triage accepted', { login: 'carol' }), core });
  const names = calls.map(([n]) => n);
  assert.deepEqual(names, ['permission', 'reaction', 'createComment']);
  assert.equal(calls[1][1].content, 'confused');
  assert.match(calls[2][1].body, /@carol thanks! Some commands were not applied/);
  assert.match(calls[2][1].body, /triage-commands\.md/);
});

test('run reports users GitHub would not assign', async () => {
  const { github, calls } = fakeGithub({ permission: 'admin', assignable: (u) => u !== 'ghost' });
  await run({ github, context: contextFor('/assign @ghost'), core });
  const comment = calls.find(([n]) => n === 'createComment');
  assert.match(comment[1].body, /@ghost cannot be assigned/);
});

test('run ignores bots and comments without commands', async () => {
  const bot = fakeGithub({ permission: 'admin' });
  await run({ github: bot.github, context: contextFor('/close', { login: 'dependabot[bot]', type: 'Bot' }), core });
  assert.equal(bot.calls.length, 0);

  const plain = fakeGithub({ permission: 'admin' });
  await run({ github: plain.github, context: contextFor('Thanks for the fix!'), core });
  assert.equal(plain.calls.length, 0);
});

test('labelNewIssue adds needs-triage unless already triaged', async () => {
  const fresh = fakeGithub();
  await labelNewIssue({ github: fresh.github, context: contextFor('', { labels: ['kind/bug'] }) });
  assert.deepEqual(fresh.calls[0][1].labels, ['needs-triage']);

  const triaged = fakeGithub();
  await labelNewIssue({ github: triaged.github, context: contextFor('', { labels: ['triage/accepted'] }) });
  assert.equal(triaged.calls.length, 0);
});
