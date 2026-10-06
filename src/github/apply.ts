// Carries out the engine's actions on GitHub. Each action is independent: one
// failure is logged and the rest continue. Nothing here makes decisions; the
// only judgment-free extras are turning successful merges and approvals into
// events, and never closing an issue whose labels could not be set.

import type { Octokit } from '@octokit/rest';
import type { RefereeConfig } from '../config.js';
import { MANAGED_LABELS } from '../engine.js';
import type { Action, RefEvent } from '../types.js';

type Log = (msg: string) => void;

const status = (e: unknown) => (e as { status?: number }).status;

export interface ApplyResult {
  done: number;
  failed: { action: Action; error: string }[];
  events: RefEvent[];
}

export async function ensureLabels(gh: Octokit, cfg: RefereeConfig, log: Log): Promise<void> {
  const existing = await gh.paginate(gh.rest.issues.listLabelsForRepo, { owner: cfg.owner, repo: cfg.repo, per_page: 100 });
  const names = new Set(existing.map((l) => l.name));
  for (const [name, spec] of Object.entries(MANAGED_LABELS)) {
    if (names.has(name)) continue;
    await gh.rest.issues.createLabel({ owner: cfg.owner, repo: cfg.repo, name, color: spec.color, description: spec.description });
    log(`created label ${name}`);
  }
}

/** Order matters: housekeeping first, gate checks next, the merge last (it needs a fresh ✅ on the head). */
const ORDER: Record<Action['type'], number> = { labels: 0, assignees: 1, comment: 2, close: 3, reopen: 3, open_issue: 4, approve_run: 5, check: 6, merge: 7 };

export async function applyActions(gh: Octokit, cfg: RefereeConfig, actions: Action[], now: Date, log: Log): Promise<ApplyResult> {
  const { owner, repo } = cfg;
  const result: ApplyResult = { done: 0, failed: [], events: [] };
  const sorted = [...actions].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  const at = now.toISOString();
  /** Issues whose labels failed: closing them would leave a decision unlabelled. */
  const unlabelled = new Set<number>();
  let merged = false;

  for (const a of sorted) {
    try {
      switch (a.type) {
        case 'labels':
          try {
            if (a.add.length) await gh.rest.issues.addLabels({ owner, repo, issue_number: a.number, labels: a.add });
            for (const name of a.remove) {
              try {
                await gh.rest.issues.removeLabel({ owner, repo, issue_number: a.number, name });
              } catch (e) {
                if (status(e) !== 404) throw e;
              }
            }
          } catch (e) {
            unlabelled.add(a.number);
            throw e;
          }
          break;
        case 'assignees':
          // GitHub silently skips users it can't assign; the `claimed` label and state.json are authoritative.
          if (a.add.length) await gh.rest.issues.addAssignees({ owner, repo, issue_number: a.number, assignees: a.add });
          if (a.remove.length) await gh.rest.issues.removeAssignees({ owner, repo, issue_number: a.number, assignees: a.remove });
          break;
        case 'comment':
          await gh.rest.issues.createComment({ owner, repo, issue_number: a.number, body: a.body });
          break;
        case 'close':
          if (unlabelled.has(a.number)) throw new Error('not closed: its labels could not be set; retried next run');
          await gh.rest.issues.update({ owner, repo, issue_number: a.number, state: 'closed', state_reason: a.reason });
          break;
        case 'reopen':
          await gh.rest.issues.update({ owner, repo, issue_number: a.number, state: 'open' });
          break;
        case 'check': {
          const output = { title: a.title.slice(0, 255), summary: a.summary.slice(0, 65_000) };
          const completed = a.status === 'completed'
            ? { status: 'completed' as const, conclusion: a.conclusion ?? 'failure', completed_at: at }
            : { status: 'in_progress' as const };
          if (a.existingId) await gh.rest.checks.update({ owner, repo, check_run_id: a.existingId, output, ...completed });
          else await gh.rest.checks.create({ owner, repo, name: cfg.gateCheckName, head_sha: a.sha, output, ...completed });
          break;
        }
        case 'open_issue': {
          const res = await gh.rest.issues.create({ owner, repo, title: a.title, body: a.body, labels: a.labels });
          log(`opened #${res.data.number}: ${a.title}`);
          break;
        }
        case 'approve_run':
          await gh.rest.actions.approveWorkflowRun({ owner, repo, run_id: a.runId });
          log(`approved CI run ${a.runId} for #${a.number}`);
          result.events.push({ id: `ci-approved:${a.runId}`, type: 'ci_run_approved', at, actor: null, item: a.number, data: { run: a.runId } });
          break;
        case 'merge': {
          // Candidates come in priority order; only the first success merges.
          if (merged) continue;
          try {
            // `sha` pins the merge to the exact commit the gate checked. If the
            // author pushed since, GitHub refuses and the next run re-evaluates.
            const res = await gh.rest.pulls.merge({
              owner,
              repo,
              pull_number: a.number,
              sha: a.sha,
              merge_method: 'squash',
              commit_title: `${a.title} (#${a.number})`.slice(0, 250),
              commit_message: 'Merged by the Assemble referee: every commons-gate rule was met.',
            });
            if (!res.data.merged) throw new Error(res.data.message || 'GitHub did not merge it');
            merged = true;
            log(`merged #${a.number} as ${res.data.sha}`);
            result.events.push({
              id: `merge:${res.data.sha}`,
              type: 'pr_merged',
              at,
              actor: a.author,
              item: a.number,
              data: { sha: res.data.sha, head: a.sha, amendment: a.amendment, closes: a.closes },
            });
          } catch (e) {
            const msg = `${status(e) ?? ''} ${(e as Error).message}`.trim();
            result.events.push({ id: `merge-failed:${a.number}:${a.sha}:${at}`, type: 'merge_failed', at, actor: null, item: a.number, data: { head: a.sha, error: msg.slice(0, 300) } });
            throw e;
          }
          break;
        }
      }
      result.done += 1;
    } catch (e) {
      const msg = `${status(e) ?? ''} ${(e as Error).message}`.trim();
      log(`FAILED ${a.type} #${a.number}: ${msg}`);
      result.failed.push({ action: a, error: msg });
    }
  }
  return result;
}
