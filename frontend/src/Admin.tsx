import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import {
  AdminUsageResponseSchema,
  AdminGenerationListResponseSchema,
  AdminUserListResponseSchema,
  AccessRequestListResponseSchema,
  ApprovalResponseSchema,
  AdminAccessRequestResponseSchema,
  AdminUserResponseSchema,
  AccountStatusSchema,
  GenerationStatusSchema,
  QuotaChangeBodySchema,
} from '@query-assistant/contracts';
import { ApiRequestError, getJson, mutateJson } from './api';
import { formatDate } from './Transcript';

type Report = z.infer<typeof AdminUsageResponseSchema>;
type Account = z.infer<typeof AdminUserListResponseSchema>['items'][number];
type Access = z.infer<typeof AccessRequestListResponseSchema>['items'][number];
type Generations = z.infer<typeof AdminGenerationListResponseSchema>;
type Change =
  | { kind: 'approve'; request: Access; reason: string }
  | { kind: 'reject'; request: Access; reason: string }
  | {
      kind: 'status';
      account: Account;
      status: z.infer<typeof AccountStatusSchema>;
      reason: string;
    }
  | {
      kind: 'quota';
      account: Account;
      body: z.infer<typeof QuotaChangeBodySchema>;
    };
const day = (offset = 0) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offset * 86400000));
const amount = (m: { amount: string; currency: string } | null) =>
  m ? `${m.currency} ${m.amount}` : 'Not reported';

export function Admin({
  onBusy,
  onSessionError,
}: {
  onBusy: (value: boolean) => void;
  onSessionError: (error: ApiRequestError) => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [generations, setGenerations] = useState<Generations | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountCursor, setAccountCursor] = useState<string | null>(null);
  const [requests, setRequests] = useState<Access[]>([]);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(
    `from=${encodeURIComponent(new Date(day() + 'T00:00:00+05:30').toISOString())}`,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const [activation, setActivation] = useState<z.infer<
    typeof ApprovalResponseSchema
  > | null>(null);
  const operation = useRef(false),
    alive = useRef(true),
    confirm = useRef<HTMLDialogElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const callbacks = useRef({ onBusy, onSessionError });
  useEffect(() => {
    callbacks.current = { onBusy, onSessionError };
  }, [onBusy, onSessionError]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    callbacks.current.onBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiRequestError && [401, 403].includes(e.status)) {
        setReport(null);
        setGenerations(null);
        setAccounts([]);
        setRequests([]);
        setActivation(null);
        callbacks.current.onSessionError(e);
      }
      setError(
        e instanceof ApiRequestError
          ? e.message
          : 'The operation could not be completed. Refresh the saved data before trying again.',
      );
      requestAnimationFrame(() => alert.current?.focus());
    } finally {
      operation.current = false;
      if (alive.current) {
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }
  async function load(q = query, signal?: AbortSignal) {
    const results = await Promise.all([
      getJson(`/api/admin/usage?${q}`, AdminUsageResponseSchema, signal),
      getJson(
        `/api/admin/generations?${q}`,
        AdminGenerationListResponseSchema,
        signal,
      ),
      getJson('/api/admin/users?limit=20', AdminUserListResponseSchema, signal),
      getJson(
        '/api/admin/access-requests?limit=20',
        AccessRequestListResponseSchema,
        signal,
      ),
    ]);
    if (!alive.current || signal?.aborted) return;
    setReport(results[0]);
    setGenerations(results[1]);
    setAccounts(results[2].items);
    setAccountCursor(results[2].nextCursor);
    setRequests(results[3].items);
    setRequestCursor(results[3].nextCursor);
  }
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted)
        void run(() => load(query, controller.signal));
    });
    return () => controller.abort();
    // Read on mount only; applying filters explicitly refreshes the report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function review(value: Change) {
    setChange(value);
    confirm.current?.showModal();
  }
  function accountForm(
    e: FormEvent<HTMLFormElement>,
    account: Account,
    kind: 'status' | 'quota',
  ) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const reason = String(data.get('reason') ?? '').trim();
    if (kind === 'status')
      review({
        kind,
        account,
        status: AccountStatusSchema.parse(data.get('status')),
        reason,
      });
    else {
      const parsed = QuotaChangeBodySchema.safeParse({
        dailyRequests: Number(data.get('dailyRequests')),
        dailyTokens: Number(data.get('dailyTokens')),
        dailyCostLimitInr: String(data.get('dailyCostLimitInr')),
        expectedVersion: account.version,
        reason,
      });
      if (!parsed.success) {
        setError(
          'Check quota values: 0–10,000 requests, 0–10,000,000 tokens and INR 0–100 with up to two decimals. A reason is required.',
        );
        return;
      }
      review({ kind, account, body: parsed.data });
    }
  }
  async function commit() {
    if (!change) return;
    const current = change;
    confirm.current?.close();
    setChange(null);
    await run(async () => {
      setActivation(null);
      if (current.kind === 'approve')
        setActivation(
          await mutateJson(
            `/api/admin/access-requests/${current.request.id}/approve`,
            'POST',
            { reason: current.reason },
            ApprovalResponseSchema,
          ),
        );
      else if (current.kind === 'reject')
        await mutateJson(
          `/api/admin/access-requests/${current.request.id}/reject`,
          'POST',
          { reason: current.reason },
          AdminAccessRequestResponseSchema,
        );
      else
        await mutateJson(
          `/api/admin/users/${current.account.user.id}/${current.kind}`,
          'PATCH',
          current.kind === 'quota'
            ? current.body
            : {
                status: current.status,
                reason: current.reason,
                expectedVersion: current.account.version,
              },
          AdminUserResponseSchema,
        );
      setNotice('Change saved. Refreshing persisted data…');
      await load();
      setNotice('Change saved and persisted data refreshed.');
    });
  }
  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      params = new URLSearchParams();
    for (const k of ['from', 'to', 'userId', 'outcome']) {
      const v = String(data.get(k) ?? '');
      if (v)
        params.set(
          k,
          k === 'from' || k === 'to'
            ? new Date(v + 'T00:00:00+05:30').toISOString()
            : v,
        );
    }
    const q = params.toString();
    setReport(null);
    setGenerations(null);
    void run(async () => {
      await load(q);
      setQuery(q);
    });
  }
  return (
    <section className="admin" aria-labelledby="admin-title">
      <h1 id="admin-title" tabIndex={-1}>
        Administration
      </h1>
      <p>
        Usage and account metadata only. Estimates are not invoices and exclude
        taxes and fees. No provider billing synchronization is configured.
      </p>
      {error && (
        <p className="error" role="alert" ref={alert} tabIndex={-1}>
          {error}
        </p>
      )}
      {notice && (
        <p className="status" role="status">
          {notice}
        </p>
      )}
      {busy && <p role="status">Loading or saving administrator data…</p>}
      <form className="admin-filters" onSubmit={filter}>
        <label>
          From date inclusive in IST
          <input type="date" name="from" defaultValue={day()} disabled={busy} />
        </label>
        <label>
          To date exclusive in IST
          <input type="date" name="to" disabled={busy} />
        </label>
        <label>
          User account ID
          <input
            name="userId"
            placeholder="All users"
            pattern="[0-9a-fA-F-]{36}"
            disabled={busy}
          />
        </label>
        <label>
          Outcome
          <select name="outcome" disabled={busy}>
            <option value="">All outcomes</option>
            {GenerationStatusSchema.options.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button disabled={busy}>Apply filters and refresh</button>
      </form>
      {report && (
        <>
          <p className="note">
            Report snapshot {formatDate(report.lastUpdatedAt)}. Timezone{' '}
            {report.timezone}. Dates filter request creation time; request
            counts include undispatched attempts. Budgets below always show the
            current period across all users and outcomes.
          </p>
          <h2>Usage summary</h2>
          <Summary value={report.summary} />
          <div className="admin-grid">
            {[
              ['Current daily budget', report.globalDailyBudget],
              ['Demonstration lifetime budget', report.globalTotalBudget],
            ].map(([label, b]) => {
              const budget = b as Report['globalDailyBudget'];
              return (
                <article className="message" key={String(label)}>
                  <h3>{String(label)}</h3>
                  <p>
                    Limit {amount(budget.limit)} · used {amount(budget.used)} ·
                    reserved {amount(budget.reserved)} · remaining{' '}
                    {amount(budget.remaining)}
                  </p>
                </article>
              );
            })}
          </div>
          <p className="note">
            Daily period starts {formatDate(report.budgetPeriodStart)} and
            resets {formatDate(report.budgetResetsAt)} IST. Quota edits never
            erase prior usage or active reservations.
          </p>
          <h2>Usage by user</h2>
          {report.perUser.length === 0 && <p>No matching requests.</p>}
          <div className="admin-grid">
            {report.perUser.map((row) => (
              <article className="message" key={row.user.id}>
                <h3>{row.user.username}</h3>
                <p className="identifier">{row.user.id}</p>
                <Summary value={row.usage} />
              </article>
            ))}
          </div>
          {report.nextCursor && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await getJson(
                    `/api/admin/usage?${query}&cursor=${report.nextCursor}`,
                    AdminUsageResponseSchema,
                  );
                  setReport({
                    ...next,
                    perUser: [
                      ...report.perUser,
                      ...next.perUser.filter(
                        (n) =>
                          !report.perUser.some((p) => p.user.id === n.user.id),
                      ),
                    ],
                  });
                })
              }
            >
              More user summaries
            </button>
          )}
        </>
      )}
      <h2>Request accounting and price history</h2>
      <p className="note">
        Latency is creation to durable finish, including attachment wait. Active
        requests have no final latency or usage. Cached tokens are part of
        input; reasoning tokens are separate from output. Accounted tokens
        include conservative bounds when usage is uncertain. Each refresh is a
        new snapshot.
      </p>
      {!generations?.items.length && <p>No matching request records.</p>}
      <div className="admin-grid">
        {generations?.items.map((g) => (
          <article className="message" key={g.id}>
            <h3>
              {g.user.username} · {g.status}
            </h3>
            <p className="identifier">Request {g.id}</p>
            <p>
              {formatDate(g.createdAt)} ·{' '}
              {g.dispatchedAt ? 'Dispatched' : 'Not dispatched'} · latency{' '}
              {g.latencyMs === null ? 'Pending' : `${g.latencyMs} ms`}
            </p>
            <p>
              Accounting {g.usage?.accountingStatus ?? 'pending / missing'} ·
              accounted tokens {g.accountedTokens ?? 'Unknown'} · local estimate{' '}
              {amount(g.usage?.estimatedCost ?? null)} · provider cost{' '}
              {amount(g.usage?.providerReportedCost ?? null)}
            </p>
            <details>
              <summary>Price snapshot and token details</summary>
              <p>
                Version {g.price.version} · model {g.price.model} · input USD{' '}
                {g.price.inputUsdPerMillion}/million · output USD{' '}
                {g.price.outputUsdPerMillion}/million · INR {g.price.inrPerUsd}
                /USD
              </p>
              <p>
                Input {g.usage?.inputTokens ?? 'Unknown'} · output{' '}
                {g.usage?.outputTokens ?? 'Unknown'} · cached{' '}
                {g.usage?.cachedInputTokens ?? 'Unknown'} · reasoning{' '}
                {g.usage?.reasoningTokens ?? 'Unknown'}
              </p>
              {g.errorCode && <p>Outcome code {g.errorCode}</p>}
            </details>
          </article>
        ))}
      </div>
      {generations?.nextCursor && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await getJson(
                `/api/admin/generations?${query}&cursor=${generations.nextCursor}`,
                AdminGenerationListResponseSchema,
              );
              setGenerations({
                ...next,
                items: [
                  ...generations.items,
                  ...next.items.filter(
                    (n) => !generations.items.some((p) => p.id === n.id),
                  ),
                ],
              });
            })
          }
        >
          More request records
        </button>
      )}
      <h2>Access requests</h2>
      <p>
        Approval provides a new activation code for manual handoff. Reapproval
        replaces the previous code. Codes expire after 24 hours; only activation
        creates an account.
      </p>
      {activation && (
        <div className="recovery" role="status">
          <p>
            Activation for <strong>{activation.request.username}</strong>{' '}
            expires {formatDate(activation.expiresAt)} IST. Share privately;
            this code is shown only in this view.
          </p>
          <label>
            One-time activation code
            <input
              readOnly
              autoComplete="off"
              value={activation.activationCode}
            />
          </label>
          <button onClick={() => setActivation(null)}>
            Dismiss activation code
          </button>
        </div>
      )}
      {!requests.length && <p>No access requests.</p>}
      <div className="admin-grid">
        {requests.map((r) => (
          <article className="message" key={r.id}>
            <h3>
              {r.username} · {r.status}
            </h3>
            <p>Requested {formatDate(r.createdAt)}</p>
            {r.status !== 'activated' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const action = (
                    e.nativeEvent as SubmitEvent
                  ).submitter?.getAttribute('value');
                  review({
                    kind: action === 'reject' ? 'reject' : 'approve',
                    request: r,
                    reason: String(data.get('reason')).trim(),
                  });
                }}
              >
                <label>
                  Reason for {r.username}
                  <input
                    name="reason"
                    required
                    maxLength={300}
                    disabled={busy}
                  />
                </label>
                <div className="dialog-actions">
                  <button name="action" value="approve" disabled={busy}>
                    {r.status === 'approved'
                      ? 'Replace activation code'
                      : 'Approve access'}
                  </button>
                  <button name="action" value="reject" disabled={busy}>
                    Reject access
                  </button>
                </div>
              </form>
            )}
          </article>
        ))}
      </div>
      {requestCursor && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await getJson(
                `/api/admin/access-requests?limit=20&cursor=${requestCursor}`,
                AccessRequestListResponseSchema,
              );
              setRequests((old) => [
                ...old,
                ...next.items.filter((n) => !old.some((p) => p.id === n.id)),
              ]);
              setRequestCursor(next.nextCursor);
            })
          }
        >
          More access requests
        </button>
      )}
      <h2>Accounts and daily quotas</h2>
      <p>
        Changes apply immediately to future admissions. Suspending or revoking
        invalidates sessions and stops local active generations. Restoring
        access requires a new login. Role assignment is not available here.
      </p>
      <div className="admin-grid">
        {accounts.map((a) => (
          <article className="message" key={`${a.user.id}-${a.version}`}>
            <h3>
              {a.user.username} · {a.user.role}
            </h3>
            <p className="identifier">{a.user.id}</p>
            <p>
              Status {a.user.status} · version {a.version}
            </p>
            <form onSubmit={(e) => accountForm(e, a, 'status')}>
              <label>
                Status for {a.user.username}
                <select
                  name="status"
                  defaultValue={a.user.status}
                  disabled={busy}
                >
                  {AccountStatusSchema.options.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Status change reason
                <input name="reason" required maxLength={300} disabled={busy} />
              </label>
              <button disabled={busy}>Review account status</button>
            </form>
            <form onSubmit={(e) => accountForm(e, a, 'quota')}>
              <label>
                Daily requests
                <input
                  name="dailyRequests"
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  defaultValue={a.quota.dailyRequests}
                  required
                  disabled={busy}
                />
              </label>
              <label>
                Daily tokens
                <input
                  name="dailyTokens"
                  type="number"
                  min={0}
                  max={10000000}
                  step={1}
                  defaultValue={a.quota.dailyTokens}
                  required
                  disabled={busy}
                />
              </label>
              <label>
                Daily estimated cost limit in INR
                <input
                  name="dailyCostLimitInr"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  defaultValue={a.quota.dailyCostLimitInr}
                  required
                  disabled={busy}
                />
              </label>
              <label>
                Quota change reason
                <input name="reason" required maxLength={300} disabled={busy} />
              </label>
              <button disabled={busy}>Review daily quota</button>
            </form>
          </article>
        ))}
      </div>
      {accountCursor && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await getJson(
                `/api/admin/users?limit=20&cursor=${accountCursor}`,
                AdminUserListResponseSchema,
              );
              setAccounts((old) => [
                ...old,
                ...next.items.filter(
                  (n) => !old.some((p) => p.user.id === n.user.id),
                ),
              ]);
              setAccountCursor(next.nextCursor);
            })
          }
        >
          More accounts
        </button>
      )}
      <dialog
        ref={confirm}
        aria-labelledby="admin-confirm-title"
        onClose={() => setChange(null)}
      >
        <h2 id="admin-confirm-title">Confirm administrator change</h2>
        {change && (
          <>
            <p>
              {change.kind === 'quota'
                ? `Set daily quota for ${change.account.user.username} to ${change.body.dailyRequests} requests, ${change.body.dailyTokens} tokens and INR ${change.body.dailyCostLimitInr}.`
                : change.kind === 'status'
                  ? `Change ${change.account.user.username} from ${change.account.user.status} to ${change.status}.`
                  : `${change.kind === 'approve' ? 'Approve' : 'Reject'} access for ${change.request.username}.`}
            </p>
            <p>
              Reason:{' '}
              {change.kind === 'quota' ? change.body.reason : change.reason}
            </p>
          </>
        )}
        <div className="dialog-actions">
          <button autoFocus onClick={() => confirm.current?.close()}>
            Cancel change
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void commit()}
          >
            Confirm change
          </button>
        </div>
      </dialog>
    </section>
  );
}
function Summary({ value: s }: { value: Report['summary'] }) {
  return (
    <div className="usage-summary">
      <p>
        {s.requests} requests · {s.dispatchedRequests} dispatched ·{' '}
        {s.pendingRequests} pending
      </p>
      <p>
        Tokens: input {s.inputTokens}, output {s.outputTokens}, cached{' '}
        {s.cachedInputTokens}, reasoning {s.reasoningTokens}. Accounted{' '}
        {s.accountedTokens}.
      </p>
      <p>
        Local estimate {amount(s.estimatedCost)} · provider-reported cost{' '}
        {amount(s.providerReportedCost)} ({s.providerReportedCostRequests}{' '}
        records)
      </p>
      <p>
        {s.reportedTokenRequests} reported-token records ·{' '}
        {s.estimatedUsageRequests} estimated records · {s.uncertainRequests}{' '}
        uncertain · {s.missingUsageRequests} without final usage. Missing or
        uncertain usage is not zero usage.
      </p>
      <p>
        Mean terminal latency{' '}
        {s.meanLatencyMs === null
          ? 'Unavailable'
          : `${Math.round(s.meanLatencyMs)} ms`}{' '}
        across {s.latencySamples} finished requests.
      </p>
      <ul className="outcomes" aria-label="Request outcomes">
        {s.outcomes.map((o) => (
          <li key={o.status}>
            {o.status}: {o.count}
          </li>
        ))}
      </ul>
    </div>
  );
}
