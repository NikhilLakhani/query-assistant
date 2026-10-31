import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import {
  AccessRequestResponseSchema,
  AnswerResponseSchema,
  ConversationListResponseSchema,
  ConversationSchema,
  CreateConversationResponseSchema,
  CurrentUserResponseSchema,
  IdSchema,
  MessageListResponseSchema,
  MessageSchema,
  SessionResponseSchema,
  SubmitMessageResponseSchema,
  GenerationResponseSchema,
} from '@query-assistant/contracts';
import { Transcript, formatDate as date } from './Transcript';
import { Admin } from './Admin';
import { Drafts } from './drafts';
import { ApiRequestError, getJson, mutateJson, streamAnswer } from './api';

type Me = z.infer<typeof CurrentUserResponseSchema>;
type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type Answer = z.infer<typeof AnswerResponseSchema>;
const PendingSchema = z.object({
  userId: IdSchema,
  conversationId: IdSchema,
  key: IdSchema,
  createdAt: z.number().finite(),
});
type Pending = z.infer<typeof PendingSchema>;
const pendingStorage = 'query-assistant-pending-submission';
function readPending(): Pending | null {
  try {
    return PendingSchema.parse(
      JSON.parse(sessionStorage.getItem(pendingStorage) ?? 'null'),
    );
  } catch {
    return null;
  }
}
const active = (result: Answer) =>
  ['reserved', 'running'].includes(result.generation.status);
const selectionStorage = 'query-assistant-selection';
function selectedFor(userId: string): string | null {
  try {
    const value = z
      .object({ userId: IdSchema, id: IdSchema })
      .parse(JSON.parse(sessionStorage.getItem(selectionStorage) ?? 'null'));
    return value.userId === userId ? value.id : null;
  } catch {
    return null;
  }
}
function select(userId: string, id: string | null) {
  try {
    if (id)
      sessionStorage.setItem(selectionStorage, JSON.stringify({ userId, id }));
    else sessionStorage.removeItem(selectionStorage);
  } catch {
    /* Selection persistence is optional; submission recovery is not. */
  }
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<'chat' | 'admin'>('chat');
  const [adminBusy, setAdminBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'login' | 'request' | 'activate'>('login');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(
    null,
  );
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const [generationId, setGenerationId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [activity, setActivity] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const operation = useRef(false);
  const drafts = useRef(new Drafts());
  const draftOwner = useRef<string | null>(null);
  const navigation = useRef(0);
  const question = useRef<HTMLTextAreaElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  function receiveMe(value: Me) {
    if (draftOwner.current !== value.user.id) {
      drafts.current.clear();
      draftOwner.current = value.user.id;
      navigation.current++;
      setDraft('');
      setConversation(null);
      setMessages([]);
      setAnswer(null);
      setGenerationId(null);
    }
    setMe(value);
    const saved = readPending();
    setPending(saved?.userId === value.user.id ? saved : null);
  }
  function changeDraft(value: string, id = conversation?.id ?? 'new') {
    drafts.current.set(id, value);
    setDraft(value);
  }
  function focusQuestion(force = true) {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        force ||
        focused === document.body ||
        focused?.id === 'question' ||
        focused?.id === 'stop-answer'
      ) {
        const pane = document.querySelector('.messages');
        const readingOlder =
          pane && pane.scrollHeight - pane.clientHeight - pane.scrollTop >= 64;
        question.current?.focus({
          preventScroll: !force && Boolean(readingOlder),
        });
      }
    });
  }
  function newConversation() {
    navigation.current++;
    setConversation(null);
    setMessages([]);
    setMessageCursor(null);
    setAnswer(null);
    setDraft(drafts.current.get('new'));
    setNavOpen(false);
    if (me) select(me.user.id, null);
    focusQuestion();
  }
  const streamController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      streamController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    getJson('/api/me', CurrentUserResponseSchema, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) receiveMe(value);
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          (!(error instanceof ApiRequestError) || error.status !== 401)
        )
          setError(
            error instanceof ApiRequestError
              ? error.message
              : 'Could not check the session.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const userId = me?.user.id;
  useEffect(() => {
    if (!userId) return;
    const epoch = navigation.current;
    const selected = selectedFor(userId);
    const controller = new AbortController();
    getJson(
      '/api/conversations',
      ConversationListResponseSchema,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setConversations(value.items);
          setConversationCursor(value.nextCursor);
          if (selected && navigation.current === epoch) {
            void Promise.all([
              getJson(
                `/api/conversations/${selected}`,
                CreateConversationResponseSchema,
                controller.signal,
              ),
              getJson(
                `/api/conversations/${selected}/messages`,
                MessageListResponseSchema,
                controller.signal,
              ),
            ])
              .then(([chat, history]) => {
                if (
                  !controller.signal.aborted &&
                  navigation.current === epoch
                ) {
                  setConversation(chat.conversation);
                  setMessages(history.items);
                  setMessageCursor(history.nextCursor);
                }
              })
              .catch(() => {
                if (!controller.signal.aborted && navigation.current === epoch)
                  select(userId, null);
              });
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Saved conversations could not be loaded.');
      });
    return () => controller.abort();
  }, [userId]);

  async function run(work: () => Promise<void>, label = 'Working…') {
    if (operation.current) return false;
    operation.current = true;
    setActivity(label);
    setBusy(true);
    setError('');
    setNotice('');
    let succeeded = false;
    try {
      await work();
      succeeded = true;
      return true;
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        ['UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(
          error.detail?.error.code ?? '',
        )
      ) {
        setMe(null);
        drafts.current.clear();
        draftOwner.current = null;
        setDraft('');
        setPending(null);
        setGenerationId(null);
        setMessages([]);
        setConversation(null);
        setAnswer(null);
      }
      setError(
        error instanceof ApiRequestError
          ? error.message +
              (error.detail?.error.retryAfterSeconds
                ? ` Try again in ${error.detail.error.retryAfterSeconds} seconds.`
                : '')
          : 'The operation could not be completed. Check saved history before sending again.',
      );
      requestAnimationFrame(() => errorBox.current?.focus());
      return false;
    } finally {
      operation.current = false;
      setActivity('');
      setBusy(false);
      if (succeeded) focusQuestion(false);
    }
  }
  async function refresh() {
    const [user, list] = await Promise.all([
      getJson('/api/me', CurrentUserResponseSchema),
      getJson('/api/conversations', ConversationListResponseSchema),
    ]);
    receiveMe(user);
    setConversations(list.items);
    setConversationCursor(list.nextCursor);
  }
  async function open(id: string) {
    navigation.current++;
    const [chat, history] = await Promise.all([
      getJson(`/api/conversations/${id}`, CreateConversationResponseSchema),
      getJson(`/api/conversations/${id}/messages`, MessageListResponseSchema),
    ]);
    setConversation(chat.conversation);
    if (me) select(me.user.id, id);
    setDraft(drafts.current.get(id));
    setNavOpen(false);
    setMessages(history.items);
    setMessageCursor(history.nextCursor);
    setAnswer(null);
  }
  function remember(value: Pending | null) {
    try {
      if (value) sessionStorage.setItem(pendingStorage, JSON.stringify(value));
      else sessionStorage.removeItem(pendingStorage);
    } catch {
      if (value) {
        setError(
          'Allow browser session storage before sending so an interrupted request can be recovered.',
        );
        return false;
      }
    }
    setPending(value);
    return true;
  }
  async function showAnswer(result: Answer) {
    await open(result.generation.conversationId);
    setAnswer(result);
    setGenerationId(active(result) ? result.generation.id : null);
    if (!active(result)) {
      remember(null);
      changeDraft(
        ['failed', 'interrupted'].includes(result.generation.status)
          ? result.userMessage.content
          : '',
        result.generation.conversationId,
      );
    }
    setNotice(
      result.failure?.message ??
        (active(result)
          ? 'This submission is still in progress. Check its saved result shortly.'
          : result.generation.status === 'cancelled'
            ? 'Answer stopped. Saved partial text may be incomplete; dispatched work can still use allowance.'
            : `Answer ${result.generation.status}.`),
    );
    await refresh();
  }
  async function recover() {
    if (!pending) return;
    try {
      await showAnswer(
        await getJson(
          `/api/conversations/${pending.conversationId}/submissions/${pending.key}`,
          AnswerResponseSchema,
        ),
      );
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 404 &&
        Date.now() - pending.createdAt > 120000
      ) {
        remember(null);
        setNotice(
          'No saved submission was found after the request deadline. You may submit your question again.',
        );
      } else throw error;
    }
  }
  function authForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get('username') ?? '');
    const password = String(data.get('password') ?? '');
    const activationCode = String(data.get('activationCode') ?? '');
    for (const name of ['password', 'activationCode']) {
      const input = event.currentTarget.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = '';
    }
    void run(async () => {
      if (mode === 'request') {
        setNotice(
          (
            await mutateJson(
              '/api/access-requests',
              'POST',
              { username },
              AccessRequestResponseSchema,
            )
          ).message,
        );
        return;
      }
      await mutateJson(
        `/api/auth/${mode}`,
        'POST',
        {
          username,
          password,
          ...(mode === 'activate' ? { activationCode } : {}),
        },
        SessionResponseSchema,
      );
      await refresh();
    });
  }
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      operation.current ||
      pending ||
      !draft.trim() ||
      !me ||
      exhausted ||
      !me.allowance.generationAvailable
    )
      return;
    void run(async () => {
      let chat = conversation;
      if (!chat) {
        chat = (
          await mutateJson(
            '/api/conversations',
            'POST',
            { title: draft.trim().slice(0, 60) },
            CreateConversationResponseSchema,
          )
        ).conversation;
        drafts.current.set(chat.id, draft);
        drafts.current.remove('new');
        navigation.current++;
        select(me.user.id, chat.id);
        setConversation(chat);
      }
      const value = {
        userId: me.user.id,
        conversationId: chat.id,
        key: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      if (!remember(value)) return;
      let admitted = false;
      try {
        const receipt = await mutateJson(
          `/api/conversations/${chat.id}/messages`,
          'POST',
          { content: draft },
          SubmitMessageResponseSchema,
          value.key,
        );
        admitted = true;
        setAnswer(null);
        setActivity('Connecting to the answer…');
        const id = receipt.generation.id;
        const assistantId = receipt.generation.assistantMessageId;
        if (!assistantId) throw new Error('Missing assistant receipt');
        setGenerationId(id);
        setMessages((old) => [
          ...old.filter(
            (m) => m.id !== receipt.userMessage.id && m.id !== assistantId,
          ),
          receipt.userMessage,
          {
            id: assistantId,
            conversationId: chat.id,
            generationId: id,
            sequence: receipt.userMessage.sequence + 1,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: receipt.generation.createdAt,
          },
        ]);
        const controller = new AbortController();
        streamController.current = controller;
        let text = '',
          timer: ReturnType<typeof setTimeout> | undefined,
          started = false;
        const flush = () => {
          clearTimeout(timer);
          timer = undefined;
          setMessages((old) =>
            old.map((message) =>
              message.id === assistantId
                ? { ...message, content: text }
                : message,
            ),
          );
        };
        try {
          await streamAnswer(
            receipt.eventsUrl,
            (event) => {
              if (event.generationId !== id)
                throw new Error('Wrong generation');
              if (event.type === 'started') {
                if (started || event.assistantMessageId !== assistantId)
                  throw new Error('Invalid stream start');
                started = true;
                setActivity('Waiting for the model…');
              } else {
                if (!started) throw new Error('Missing stream start');
                if (event.type === 'delta') {
                  setActivity('Receiving the answer…');
                  if (text.length + event.text.length > 128000)
                    throw new Error('Response too large');
                  text += event.text;
                  timer ??= setTimeout(flush, 50);
                } else flush();
              }
            },
            controller.signal,
          );
          await showAnswer(
            await getJson(
              `/api/conversations/${chat.id}/submissions/${value.key}`,
              AnswerResponseSchema,
            ),
          );
        } finally {
          flush();
          streamController.current = null;
        }
      } catch (error) {
        // Structured pre-reservation rejections can be corrected. All other
        // outcomes stay ambiguous; recovery uses GET rather than another POST.
        if (
          !admitted &&
          error instanceof ApiRequestError &&
          ([
            'VALIDATION_ERROR',
            'CONFLICT',
            'QUOTA_EXCEEDED',
            'RATE_LIMITED',
            'CONCURRENCY_LIMIT',
            'SERVICE_NOT_READY',
            'PROVIDER_UNAVAILABLE',
            'CSRF_INVALID',
          ].includes(error.detail?.error.code ?? '') ||
            [413, 415].includes(error.status))
        )
          remember(null);
        if (
          error instanceof ApiRequestError &&
          error.detail?.error.code === 'QUOTA_EXCEEDED'
        )
          await refresh().catch(() => {});
        throw error;
      }
    }, 'Preparing your question…');
  }
  const exhausted = Boolean(
    me &&
    (me.allowance.requests.remaining <= 0 ||
      me.allowance.tokens.remaining <= 0 ||
      Number(me.allowance.estimatedCost.remaining.amount) <= 0),
  );
  const retry = Boolean(
    answer &&
    ['failed', 'interrupted'].includes(answer.generation.status) &&
    draft.trim() === answer.userMessage.content,
  );

  return (
    <main>
      <a
        className="skip-link"
        href={
          me ? (view === 'admin' ? '#admin-title' : '#question') : '#auth-title'
        }
      >
        {me && view === 'admin' ? 'Skip to administration' : 'Skip to question'}
      </a>
      <header>
        <span className="mark" aria-hidden="true">
          Q
        </span>
        <strong>Query Assistant</strong>
        {me && (
          <div className="account">
            <span>{me.user.username}</span>
            {me.user.role === 'admin' && (
              <button
                disabled={busy || adminBusy || Boolean(pending)}
                aria-pressed={view === 'admin'}
                onClick={() => setView(view === 'admin' ? 'chat' : 'admin')}
              >
                {view === 'admin' ? 'Back to chat' : 'Administration'}
              </button>
            )}
            <button
              disabled={busy || adminBusy}
              onClick={() => void run(refresh, 'Refreshing allowance…')}
            >
              Refresh allowance
            </button>
            <button
              disabled={busy || adminBusy}
              onClick={() =>
                void run(async () => {
                  await mutateJson(
                    '/api/auth/logout',
                    'POST',
                    {},
                    z.undefined(),
                  );
                  setMe(null);
                  setView('chat');
                  drafts.current.clear();
                  draftOwner.current = null;
                  setPending(null);
                  setGenerationId(null);
                  setMessages([]);
                  setConversations([]);
                  setConversation(null);
                  setDraft('');
                  setAnswer(null);
                })
              }
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {error && (
        <p className="error" role="alert" tabIndex={-1} ref={errorBox}>
          {error}
        </p>
      )}
      {notice && (
        <p className="status" role="status">
          {notice}
        </p>
      )}
      {busy && (
        <p className="activity" role="status" aria-live="polite">
          {activity}
        </p>
      )}
      {loading ? (
        <p role="status">Checking your session…</p>
      ) : !me ? (
        <section className="auth" aria-labelledby="auth-title">
          <p className="eyebrow">APPROVED ACCOUNTS</p>
          <h1 id="auth-title" tabIndex={-1}>
            {mode === 'login'
              ? 'Sign in to ask a question.'
              : mode === 'request'
                ? 'Request access.'
                : 'Activate your account.'}
          </h1>
          <div className="tabs" aria-label="Account options">
            {(['login', 'request', 'activate'] as const).map((value) => (
              <button
                key={value}
                disabled={busy}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setError('');
                  setNotice('');
                }}
              >
                {value === 'login'
                  ? 'Sign in'
                  : value === 'request'
                    ? 'Request access'
                    : 'Activate'}
              </button>
            ))}
          </div>
          <form onSubmit={authForm}>
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                required
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9_]+"
                disabled={busy}
              />
            </label>
            {mode === 'activate' && (
              <label>
                One-time activation code
                <input
                  name="activationCode"
                  autoComplete="off"
                  required
                  minLength={32}
                  maxLength={256}
                  disabled={busy}
                />
              </label>
            )}
            {mode !== 'request' && (
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'login' ? 'current-password' : 'new-password'
                  }
                  required
                  minLength={mode === 'activate' ? 12 : 1}
                  maxLength={128}
                  disabled={busy}
                />
              </label>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'request'
                    ? 'Request approval'
                    : 'Activate account'}
            </button>
          </form>
          <p className="note">
            An administrator must approve new accounts. After approval, enter
            the activation code they give you and choose a password of 12–128
            characters.
          </p>
        </section>
      ) : me.user.role === 'admin' && view === 'admin' ? (
        <Admin
          key={me.user.id}
          onBusy={setAdminBusy}
          onSessionError={(error) => {
            setView('chat');
            setAdminBusy(false);
            void run(async () => {
              throw error;
            });
          }}
        />
      ) : (
        <>
          <div className="allowance">
            <span>
              {me.allowance.requests.remaining} requests remaining today
            </span>
            <span>
              {me.allowance.tokens.remaining.toLocaleString()} tokens remaining
            </span>
            <span>
              INR {me.allowance.estimatedCost.remaining.amount} estimated budget
              remaining
            </span>
            <small>
              Resets {date(me.allowance.resetsAt)} IST. Global limits also
              apply.
            </small>
          </div>
          {!me.allowance.generationAvailable && (
            <div className="status">
              <p>
                Chat is temporarily unavailable. Check saved history and try
                later; the administrator may need to review the service.
              </p>
              <button disabled={busy} onClick={() => void run(refresh)}>
                Refresh service status
              </button>
            </div>
          )}
          {exhausted && (
            <p className="status" role="status">
              Your daily allowance is exhausted. It resets{' '}
              {date(me.allowance.resetsAt)} IST. Saved conversations remain
              available.
            </p>
          )}
          {pending && (
            <div className="recovery">
              <p>
                {busy
                  ? 'Your question is in progress. Use Stop answer to end local waiting.'
                  : 'This submission is unresolved. Check its saved result before sending another question.'}
              </p>
              <button
                disabled={busy}
                onClick={() => void run(recover, 'Checking saved result…')}
              >
                Check saved result
              </button>
            </div>
          )}
          <div className="workspace">
            <aside aria-label="Saved conversations">
              <button
                disabled={busy || Boolean(pending)}
                onClick={newConversation}
              >
                New conversation
              </button>
              <button
                className="nav-toggle"
                aria-expanded={navOpen}
                aria-controls="saved-chats"
                onClick={() => setNavOpen(!navOpen)}
              >
                {navOpen
                  ? 'Hide saved conversations'
                  : 'Show saved conversations'}
              </button>
              <nav
                id="saved-chats"
                className={navOpen ? 'saved-chats open' : 'saved-chats'}
                aria-label="Conversation navigation"
              >
                <ul>
                  {conversations.map((chat) => (
                    <li key={chat.id}>
                      <button
                        className={
                          conversation?.id === chat.id ? 'selected' : ''
                        }
                        disabled={busy}
                        aria-current={
                          conversation?.id === chat.id ? 'page' : undefined
                        }
                        onClick={() =>
                          void run(() => open(chat.id), 'Loading conversation…')
                        }
                      >
                        {chat.title}
                        <small>{date(chat.updatedAt)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
                {conversationCursor && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const list = await getJson(
                          `/api/conversations?cursor=${conversationCursor}`,
                          ConversationListResponseSchema,
                        );
                        setConversations((old) => [
                          ...old,
                          ...list.items.filter(
                            (item) => !old.some((row) => row.id === item.id),
                          ),
                        ]);
                        setConversationCursor(list.nextCursor);
                      })
                    }
                  >
                    More conversations
                  </button>
                )}
              </nav>
            </aside>
            <section className="chat" aria-labelledby="chat-title">
              <h1 id="chat-title">
                {conversation?.title ?? 'What would you like to know?'}
              </h1>
              {conversation && (
                <button
                  className="delete-chat"
                  disabled={busy || Boolean(pending)}
                  onClick={() => deleteDialog.current?.showModal()}
                >
                  Delete conversation
                </button>
              )}
              <p className="note">
                Answers use model knowledge and recent completed turns. Older
                turns may be omitted. No web search is available; check
                important facts.
              </p>
              <Transcript
                messages={messages}
                conversationId={conversation?.id ?? null}
                busy={busy}
                {...(messageCursor && conversation
                  ? {
                      older: () =>
                        run(async () => {
                          const history = await getJson(
                            `/api/conversations/${conversation.id}/messages?cursor=${messageCursor}`,
                            MessageListResponseSchema,
                          );
                          setMessages((old) => [...history.items, ...old]);
                          setMessageCursor(history.nextCursor);
                        }, 'Loading earlier messages…'),
                    }
                  : {})}
              />
              {answer?.usage && (
                <p className="note">
                  Usage: {answer.usage.accountingStatus}; estimated cost INR{' '}
                  {answer.usage.estimatedCost?.amount ?? 'unknown'}. This is not
                  a provider invoice.
                </p>
              )}
              {generationId && (
                <button
                  id="stop-answer"
                  type="button"
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    void mutateJson(
                      `/api/generations/${generationId}/cancel`,
                      'POST',
                      {},
                      GenerationResponseSchema,
                    )
                      .then(async () => {
                        if (!busy) await recover();
                      })
                      .catch(() =>
                        setError(
                          'Stop could not be confirmed. Check saved history.',
                        ),
                      )
                      .finally(() => {
                        setStopping(false);
                        focusQuestion(false);
                      });
                  }}
                >
                  {stopping ? 'Stopping…' : 'Stop answer'}
                </button>
              )}
              <form className="composer" onSubmit={send}>
                <label htmlFor="question">Your question</label>
                <textarea
                  id="question"
                  ref={question}
                  aria-describedby="question-help question-count"
                  value={draft}
                  onChange={(event) => changeDraft(event.target.value)}
                  maxLength={8000}
                  required
                  disabled={busy || Boolean(pending)}
                  rows={4}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      (event.ctrlKey || event.metaKey) &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <p id="question-help" className="note">
                  Enter adds a new line. Ctrl/Cmd + Enter sends. Drafts stay in
                  this tab's memory and clear on sign out or reload.
                  {retry ? ' Trying again can use another request.' : ''}
                </p>
                <div className="composer-actions">
                  <span id="question-count" className="note">
                    {draft.length}/8,000 characters
                  </span>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      Boolean(pending) ||
                      !draft.trim() ||
                      exhausted ||
                      !me.allowance.generationAvailable
                    }
                  >
                    {busy
                      ? 'Working…'
                      : retry
                        ? 'Try question again'
                        : 'Send question'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        </>
      )}
      <dialog
        ref={deleteDialog}
        aria-labelledby="delete-title"
        aria-describedby="delete-description"
      >
        <h2 id="delete-title">Delete this conversation?</h2>
        <p id="delete-description">
          Saved messages will be removed. Used allowance and accounting records
          remain.
        </p>
        <div className="dialog-actions">
          <button autoFocus onClick={() => deleteDialog.current?.close()}>
            Keep conversation
          </button>
          <button
            className="danger"
            onClick={() => {
              deleteDialog.current?.close();
              if (!conversation || !me) return;
              const id = conversation.id;
              void run(async () => {
                await mutateJson(
                  `/api/conversations/${id}`,
                  'DELETE',
                  {},
                  z.undefined(),
                );
                drafts.current.remove(id);
                newConversation();
                await refresh();
                setNotice(
                  'Conversation deleted. Used allowance remains unchanged.',
                );
              }, 'Deleting conversation…');
            }}
          >
            Delete messages
          </button>
        </div>
      </dialog>
      <footer>Query Assistant · Times shown in Asia/Kolkata</footer>
    </main>
  );
}
