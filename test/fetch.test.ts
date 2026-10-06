// fetchSnapshot end to end against a fake GitHub: the calls it makes, the
// response shapes it reads, and that the engine can run on what it returns.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Octokit } from '@octokit/rest';
import { evaluate } from '../src/engine.js';
import { fetchSnapshot } from '../src/github/fetch.js';
import { EventLog } from '../src/log.js';
import type { RefEvent } from '../src/types.js';
import { at, config, LAUNCH_POLICY } from './helpers.js';

const user = (login: string) => ({ login, type: login.endsWith('[bot]') ? 'Bot' : 'User' });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const fail = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function fakeGitHub() {
  const calls: string[] = [];
  const issues = [
    { number: 1, title: '[proposal] idea', body: 'text', user: user('alice'), state: 'open', state_reason: null, created_at: at(10), closed_at: null, labels: [{ name: 'proposal' }], assignees: [] },
    { number: 2, title: '[task] work', body: '', user: user('alice'), state: 'open', state_reason: null, created_at: at(11), closed_at: null, labels: [], assignees: [] },
    { number: 3, title: 'Add index', body: 'Closes #2', user: user('bob'), state: 'open', created_at: at(20), labels: [], assignees: [], pull_request: { merged_at: null } },
    { number: 4, title: 'Merged one', body: 'Closes #9', user: user('carol'), state: 'closed', created_at: at(15), labels: [], assignees: [], pull_request: { merged_at: at(30) } },
    { number: 5, title: 'Unreadable', body: '', user: user('dave'), state: 'open', created_at: at(21), labels: [], assignees: [], pull_request: { merged_at: null } },
    { number: 6, title: 'pre-launch', body: '', user: user('alice'), state: 'open', created_at: at(-30), labels: [], assignees: [] },
    { number: 7, title: '[proposal] closed by the operator', body: '', user: user('erin'), state: 'closed', state_reason: 'not_planned', created_at: at(16), closed_at: at(17), labels: [], assignees: [] },
  ];
  const comments = [
    { id: 100, issue_url: 'https://api.github.com/repos/o/r/issues/2', user: user('bob'), body: '/claim', created_at: at(12), updated_at: at(12) },
    { id: 101, issue_url: 'https://api.github.com/repos/o/r/issues/1', user: user('carol'), body: '/object no', created_at: at(13), updated_at: at(13) },
  ];
  const head = (number: number, repo: string, ref: string, sha: string) => ({ number, title: `PR ${number}`, body: number === 3 ? 'Closes #2' : '', user: user(number === 3 ? 'bob' : 'dave'), created_at: at(number === 3 ? 20 : 21), head: { sha, ref, repo: { full_name: repo, name: 'commons', owner: { login: repo.split('/')[0] } } } });
  const pulls = [head(3, 'bob/commons', 'index', 'h3'), head(5, 'dave/commons', 'main', 'h5')];
  const runs = [
    { id: 1, head_repository: { full_name: 'bob/commons' }, head_branch: 'index', head_sha: 'h3', created_at: at(20), check_suite_id: 11, conclusion: 'success' },
    { id: 2, head_repository: { full_name: 'eve/commons' }, head_branch: 'index', head_sha: 'h3', created_at: at(25), check_suite_id: 12, conclusion: 'success' },
  ];
  // main: p0 (pre-launch, adds policy.yaml) <- m1 (operator push after launch) <- m2 (referee merge of #4)
  const mainCommits = [
    { sha: 'm2', parents: [{ sha: 'm1' }], commit: { committer: { date: at(30) }, author: { name: 'carol' } }, author: { login: 'carol' } },
    { sha: 'm1', parents: [{ sha: 'p0' }], commit: { committer: { date: at(5) }, author: { name: 'op' } }, author: { login: 'founder' } },
    { sha: 'p0', parents: [], commit: { committer: { date: at(-10) }, author: { name: 'op' } }, author: { login: 'founder' } },
  ];

  const ok = (name: string, fn: (p: Record<string, unknown>) => unknown) => async (p: Record<string, unknown> = {}) => {
    calls.push(name);
    return { data: await fn(p) };
  };
  const rest = {
    issues: {
      listForRepo: ok('issues.listForRepo', () => issues),
      listCommentsForRepo: ok('issues.listCommentsForRepo', () => comments),
      // The list doesn't say who closed an issue; the single-issue endpoint does.
      get: ok('issues.get', (p) => ({ number: p.issue_number, closed_by: p.issue_number === 7 ? user('founder') : null })),
    },
    repos: {
      getBranch: ok('repos.getBranch', () => ({ commit: { sha: 'm2' } })),
      listCommits: ok('repos.listCommits', (p) => (p.path ? [{ sha: 'p0', commit: { committer: { date: at(-10) } } }] : mainCommits)),
      getCommit: ok('repos.getCommit', (p) => {
        const c = mainCommits.find((x) => x.sha === p.ref);
        if (!c) throw fail(404);
        return c;
      }),
      getContent: ok('repos.getContent', () => ({ type: 'file', content: b64(LAUNCH_POLICY) })),
      compareCommitsWithBasehead: ok('repos.compareCommitsWithBasehead', () => ({ behind_by: 0 })),
      listPullRequestsAssociatedWithCommit: ok('repos.listPullRequestsAssociatedWithCommit', (p) => (p.commit_sha === 'm2' ? [{ number: 4, merge_commit_sha: 'm2', merged_at: at(30) }] : [])),
    },
    checks: {
      listForRef: ok('checks.listForRef', (p) => ({ check_runs: p.ref === 'h3' ? [{ id: 9, name: 'ci', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: at(20), check_suite: { id: 11 } }] : [] })),
    },
    pulls: {
      list: ok('pulls.list', () => pulls),
      get: ok('pulls.get', (p) => {
        if (p.pull_number === 5) throw fail(502);
        if (p.pull_number === 4) return { merged_by: { login: 'assemble-referee[bot]' } };
        return { ...pulls[0], draft: false, base: { ref: 'main' }, labels: [], changed_files: 1, mergeable: true };
      }),
      listFiles: ok('pulls.listFiles', () => [{ filename: 'src/index.js' }]),
      listReviews: ok('pulls.listReviews', () => []),
    },
    actions: {
      listWorkflowRunsForRepo: ok('actions.listWorkflowRunsForRepo', (p) => {
        assert.equal(p.event, 'pull_request');
        assert.match(String(p.created), /^>=\d{4}-/);
        return { total_count: runs.length, workflow_runs: runs };
      }),
    },
  };
  const gh = {
    rest,
    // Octokit's paginate returns the items, unwrapping { total_count, <items> } responses.
    paginate: async (method: (p: Record<string, unknown>) => Promise<{ data: unknown }>, params: Record<string, unknown>) => {
      const { data } = await method(params);
      if (Array.isArray(data)) return data;
      const d = data as Record<string, unknown>;
      return (d.workflow_runs ?? d.check_runs ?? []) as unknown[];
    },
    graphql: async (query: string) => {
      if (query.includes('HEAD_REF_FORCE_PUSHED_EVENT')) {
        calls.push('graphql:force-pushes');
        assert.match(query, /p3: pullRequest\(number: 3\)/);
        return { repository: { p3: { timelineItems: { nodes: [{ createdAt: at(19), afterCommit: { oid: 'older' } }, { createdAt: at(22), afterCommit: { oid: 'h3' } }] } } } };
      }
      if (query.includes('discussions(')) {
        calls.push('graphql:discussions');
        const post = (id: string, login: string, h: number) => ({ id, createdAt: at(h), author: { login, __typename: 'User' } });
        return { repository: { discussions: { nodes: [
          { number: 1, createdAt: at(18), updatedAt: at(22), author: { login: 'zed', __typename: 'User' }, comments: { nodes: [{ ...post('DC_1', 'founder', 19), replies: { nodes: [post('DC_2', 'yan', 20)] } }] } },
          { number: 2, createdAt: at(-300), updatedAt: at(-200), author: { login: 'old', __typename: 'User' }, comments: { nodes: [] } }, // not updated recently
        ] } } };
      }
      calls.push('graphql:edits');
      assert.match(query, /i1: issue\(number: 1\)/);
      assert.doesNotMatch(query, /issue\(number: 2\)/); // tasks don't need their edit history
      return { repository: { i1: { e1: { nodes: [{ editedAt: at(14) }] }, e2: { nodes: [] }, r1: { nodes: [{ createdAt: at(15) }] }, r2: { nodes: [] } }, i7: null } };
    },
  };
  return { gh: gh as unknown as Octokit, calls };
}

test('fetchSnapshot reads the commons, isolates a failing PR, and the engine runs on the result', async () => {
  const { gh, calls } = fakeGitHub();
  const logLines: string[] = [];
  const log: RefEvent[] = [];
  const cfg = config();
  const snap = await fetchSnapshot(gh, cfg, new Date(at(40)), { log: new EventLog(log), previousMainSha: null, pullBudget: 60 }, (m) => logLines.push(m));

  // Items before launch are left out.
  assert.deepEqual(snap.issues.map((i) => i.number), [1, 2, 7]);
  // The proposal's edit history: a body edit and a title rename.
  assert.deepEqual(snap.issues[0]?.edits, [at(14), at(15)]);
  assert.deepEqual(snap.issues[1]?.comments.map((c) => c.id), [100]);
  // Who closed the closed proposal (only the single-issue endpoint says).
  assert.deepEqual(snap.issues[2]?.closedBy, { login: 'founder', isBot: false });
  // Discussions: recent posts only.
  assert.deepEqual(snap.discussions.map((d) => [d.id, d.author]), [['discussion-1', 'zed'], ['DC_1', 'founder'], ['DC_2', 'yan']]);

  // PR #5 couldn't be read: logged and skipped, not fatal. Both still have a summary.
  assert.deepEqual(snap.openPulls.map((p) => p.number), [3]);
  assert.deepEqual(snap.pullStubs.map((p) => p.number), [3, 5]);
  assert.ok(logLines.some((l) => l.includes('could not inspect PR #5')));
  assert.equal(snap.openPulls[0]?.checks[0]?.suiteId, 11);
  // The last force-push to the current head, from the PR timeline.
  assert.equal(snap.openPulls[0]?.forcePushedAt, at(22));

  // Only bob's own run is a push to #3; eve built the same commit from her fork.
  assert.deepEqual(snap.ciRuns.map((r) => [r.id, r.pull]), [[1, 3]]);

  // main: m1 is new and not the referee's; m2 is the referee's merge of #4; p0 is the launch anchor.
  assert.deepEqual(snap.main.commits.map((c) => [c.sha, c.mergedByReferee]), [['m1', false], ['m2', true]]);
  assert.equal(snap.main.anchor?.sha, 'p0');
  assert.equal(snap.main.rewritten, null);
  assert.equal(snap.mergedPulls[0]?.number, 4);
  assert.equal(snap.policyHistory.length, 1);
  assert.ok(calls.includes('graphql:edits'));

  snap.log = log;
  const r = evaluate(snap, cfg);
  assert.ok(r.events.some((e) => e.id === 'intervention:m1'));
  assert.ok(r.events.some((e) => e.id === 'push:3:1' && e.data?.closes instanceof Array && (e.data.closes as number[]).includes(2)));
  assert.ok(r.events.some((e) => e.type === 'task_claimed' && e.item === 2));
  assert.equal((r.state.open_pull_requests as number), 2);
  // The operator closing someone's proposal, and posting in Discussions, are on the record as interventions.
  assert.equal(r.events.find((e) => e.id === `closed:7:${at(17)}`)?.incident, 'operator_intervention');
  assert.equal(r.events.find((e) => e.type === 'proposal_withdrawn')?.actor, 'founder');
  assert.equal(r.events.find((e) => e.id === 'operator-discussion:DC_1')?.incident, 'operator_intervention');
  // People who only take part in Discussions are participants too.
  assert.ok(r.events.some((e) => e.id === 'participant:yan'));
  assert.ok(!r.events.some((e) => e.id === 'participant:founder'));
});

test('the next run stops at what the first one recorded, and notices a rewritten main', async () => {
  const first = fakeGitHub();
  const cfg = config();
  const snap = await fetchSnapshot(first.gh, cfg, new Date(at(40)), { log: new EventLog([]), previousMainSha: null, pullBudget: 60 }, () => {});
  snap.log = [];
  const events = evaluate(snap, cfg).events;

  const again = fakeGitHub();
  const next = await fetchSnapshot(again.gh, cfg, new Date(at(41)), { log: new EventLog(events), previousMainSha: 'm2', pullBudget: 60 }, () => {});
  assert.deepEqual(next.main.commits, []);
  assert.equal(next.main.rewritten, null);
  assert.equal(again.calls.filter((c) => c === 'repos.listPullRequestsAssociatedWithCommit').length, 0);
  // A close already recorded isn't looked up again.
  assert.equal(again.calls.includes('issues.get'), false);

  const rewritten = await fetchSnapshot(fakeGitHub().gh, cfg, new Date(at(41)), { log: new EventLog(events), previousMainSha: 'gone', pullBudget: 60 }, () => {});
  assert.deepEqual(rewritten.main.rewritten, { from: 'gone', to: 'm2' });
});

test('decided proposals don\'t need their edit history fetched', async () => {
  const { gh, calls } = fakeGitHub();
  const decided: RefEvent[] = [
    { id: 'proposal-accepted:1', type: 'proposal_accepted', at: at(30), actor: null, item: 1 },
    { id: 'proposal-withdrawn:7', type: 'proposal_withdrawn', at: at(17), actor: 'founder', item: 7 },
  ];
  await fetchSnapshot(gh, config(), new Date(at(40)), { log: new EventLog(decided), previousMainSha: null, pullBudget: 60 }, () => {});
  assert.equal(calls.includes('graphql:edits'), false);
});

test('Discussions that can\'t be read are skipped, not fatal', async () => {
  const { gh } = fakeGitHub();
  const broken = { ...gh, graphql: async (q: string) => {
    if (q.includes('discussions(')) throw new Error('Resource not accessible by integration');
    return (gh as unknown as { graphql: (q: string) => Promise<unknown> }).graphql(q);
  } } as unknown as Octokit;
  const lines: string[] = [];
  const snap = await fetchSnapshot(broken, config(), new Date(at(40)), { log: new EventLog([]), previousMainSha: null, pullBudget: 60 }, (m) => lines.push(m));
  assert.deepEqual(snap.discussions, []);
  assert.ok(lines.some((l) => l.includes('could not read Discussions')));
});
