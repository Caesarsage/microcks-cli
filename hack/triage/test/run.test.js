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

// Run with: node --test hack/triage/test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, labelNewIssue } = require('../run');

// run() and labelNewIssue() against a fake GitHub client.

// labels and closedBy describe the issue as GitHub returns it now, which can
// differ from the event payload.
function fakeGithub({ permission = 'read', assignable = () => true, runs = [], labels = [], closedBy = null } = {}) {
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
        get: record('getIssue', () => ({ data: { labels: labels.map((name) => ({ name })), closed_by: closedBy && { login: closedBy } } })),
        addLabels: record('addLabels'),
        removeLabel: record('removeLabel'),
        addAssignees: record('addAssignees', ({ assignees }) => ({ data: { assignees: assignees.filter(assignable).map((login) => ({ login })) } })),
        removeAssignees: record('removeAssignees'),
        update: record('update'),
        createComment: record('createComment'),
      },
      reactions: { createForIssueComment: record('reaction') },
      pulls: {
        get: record('getPull', () => ({ data: { head: { sha: 'abc123' } } })),
        requestReviewers: record('requestReviewers'),
        removeRequestedReviewers: record('removeRequestedReviewers'),
      },
      actions: {
        listWorkflowRunsForRepo: record('listRuns', () => ({ data: { workflow_runs: runs } })),
        reRunWorkflowFailedJobs: record('rerun'),
        listWorkflowRuns: record('listHoldRuns', () => ({ data: { workflow_runs: [{ id: 42 }] } })),
        reRunWorkflow: record('rerunHold'),
      },
    },
  };
  return { github, calls };
}

const core = { warning: () => {} };

function contextFor(body, { login = 'alice', type = 'User', labels = [], pr = false, association = 'NONE' } = {}) {
  return {
    repo: { owner: 'microcks', repo: 'microcks-cli' },
    payload: {
      comment: { id: 99, body, user: { login, type }, author_association: association },
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
  const { github, calls } = fakeGithub({ permission: 'write', labels: ['needs-triage'] });
  await run({ github, context: contextFor('/triage accepted\n/kind bug'), core });
  const names = calls.map(([n]) => n);
  assert.deepEqual(names, ['permission', 'getIssue', 'removeLabel', 'addLabels', 'reaction']);
  assert.deepEqual(calls[3][1].labels, ['triage/accepted', 'kind/bug']);
  assert.equal(calls[4][1].content, '+1');
});

test('run treats non-collaborators (404) as contributors and explains', async () => {
  const { github, calls } = fakeGithub({ permission: null });
  await run({ github, context: contextFor('/triage accepted', { login: 'carol' }), core });
  const names = calls.map(([n]) => n);
  assert.deepEqual(names, ['permission', 'getIssue', 'reaction', 'createComment']);
  assert.equal(calls[2][1].content, 'confused');
  assert.match(calls[3][1].body, /@carol thanks! Some commands were not applied/);
  assert.match(calls[3][1].body, /triage-commands\.md/);
});

test('run lets past contributors triage using the comment author association', async () => {
  const { github, calls } = fakeGithub({ permission: 'read', labels: ['needs-triage'] });
  await run({ github, context: contextFor('/triage accepted', { login: 'dan', association: 'CONTRIBUTOR' }), core });
  assert.deepEqual(calls.map(([n]) => n), ['permission', 'getIssue', 'removeLabel', 'addLabels', 'reaction']);
  assert.deepEqual(calls[3][1].labels, ['triage/accepted']);
});

test('run uses current labels, not the event payload snapshot', async () => {
  // A maintainer accepted the issue after this comment's event was created.
  const { github, calls } = fakeGithub({ permission: 'read', labels: ['triage/accepted'] });
  await run({ github, context: contextFor('/assign', { login: 'carol', labels: ['needs-triage'] }), core });
  assert.deepEqual(calls.find(([n]) => n === 'addAssignees')[1].assignees, ['carol']);
  assert.equal(calls.at(-1)[1].content, '+1');
});

test('run passes who closed the item, so authors cannot reopen a maintainer close', async () => {
  const { github, calls } = fakeGithub({ permission: 'read', closedBy: 'alice' });
  await run({ github, context: contextFor('/reopen', { login: 'bob' }), core });
  assert.equal(calls.find(([n]) => n === 'update'), undefined);
  assert.match(calls.find(([n]) => n === 'createComment')[1].body, /a maintainer closed/);
});

test('run reports users GitHub would not assign', async () => {
  const { github, calls } = fakeGithub({ permission: 'admin', assignable: (u) => u !== 'ghost' });
  await run({ github, context: contextFor('/assign @ghost'), core });
  const comment = calls.find(([n]) => n === 'createComment');
  assert.match(comment[1].body, /@ghost cannot be assigned/);
});

test('run re-runs only failed workflow runs on the pull request head', async () => {
  const runs = [{ id: 1, conclusion: 'failure' }, { id: 2, conclusion: 'success' }, { id: 3, conclusion: 'timed_out' }];
  const { github, calls } = fakeGithub({ permission: 'write', runs });
  await run({ github, context: contextFor('/retest', { pr: true }), core });
  assert.equal(calls.find(([n]) => n === 'listRuns')[1].head_sha, 'abc123');
  assert.deepEqual(calls.filter(([n]) => n === 'rerun').map(([, a]) => a.run_id), [1, 3]);
  assert.equal(calls.at(-1)[1].content, '+1');
});

test('run explains when there is nothing to retest', async () => {
  const { github, calls } = fakeGithub({ permission: 'write', runs: [{ id: 2, conclusion: 'success' }] });
  await run({ github, context: contextFor('/retest', { pr: true }), core });
  assert.match(calls.find(([n]) => n === 'createComment')[1].body, /no failed checks/);
});

test('run requests reviewers on pull requests', async () => {
  const { github, calls } = fakeGithub({ permission: 'write' });
  await run({ github, context: contextFor('/cc @dave', { pr: true }), core });
  const req = calls.find(([n]) => n === 'requestReviewers');
  assert.deepEqual(req[1], { owner: 'microcks', repo: 'microcks-cli', pull_number: 7, reviewers: ['dave'] });
});

test('run re-runs the hold check after /hold', async () => {
  const { github, calls } = fakeGithub({ permission: 'write' });
  await run({ github, context: contextFor('/hold', { pr: true }), core });
  const list = calls.find(([n]) => n === 'listHoldRuns')[1];
  assert.equal(list.workflow_id, 'hold.yml');
  assert.equal(list.head_sha, 'abc123');
  assert.equal(calls.find(([n]) => n === 'rerunHold')[1].run_id, 42);
  assert.equal(calls.at(-1)[1].content, '+1');
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
