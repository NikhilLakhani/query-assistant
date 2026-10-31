import { useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@query-assistant/contracts';
import { AnswerMarkdown } from './Markdown';
export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));

export function Transcript({
  messages,
  conversationId,
  older,
  busy,
}: {
  messages: Message[];
  conversationId: string | null;
  older?: () => Promise<boolean>;
  busy: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef(conversationId);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    let frame: number | undefined;
    if (previous.current !== conversationId) {
      previous.current = conversationId;
      pinned.current = true;
      anchor.current = null;
      frame = requestAnimationFrame(() => setAtBottom(true));
    }
    if (anchor.current) {
      element.scrollTop =
        anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (pinned.current) element.scrollTop = element.scrollHeight;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [messages, conversationId]);
  return (
    <div className="transcript">
      <div
        ref={panel}
        className="messages"
        role="log"
        aria-label="Conversation messages"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const element = panel.current!;
          const bottom =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            64;
          pinned.current = bottom;
          setAtBottom(bottom);
        }}
      >
        {older && (
          <button
            disabled={busy}
            onClick={() => {
              const element = panel.current!;
              anchor.current = {
                height: element.scrollHeight,
                top: element.scrollTop,
              };
              pinned.current = false;
              void older().then((ok) => {
                if (!ok) anchor.current = null;
              });
            }}
          >
            Earlier messages
          </button>
        )}
        {!messages.length && (
          <div className="empty-chat">
            <strong>Your conversation starts here.</strong>
            <p>
              Write a question below. Answers and follow-ups will be saved to
              this account.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            id={`message-${message.id}`}
            className={`message ${message.role}`}
            aria-label={`${message.role === 'user' ? 'Your message' : 'Assistant answer'}, ${message.status}`}
          >
            <div className="message-meta">
              <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              <time dateTime={message.createdAt}>
                {formatDate(message.createdAt)}
              </time>
              <span>{message.status}</span>
            </div>
            {message.role === 'assistant' && message.content ? (
              <AnswerMarkdown content={message.content} />
            ) : (
              <p>
                {message.content ||
                  (message.status === 'streaming'
                    ? 'Waiting for an answer…'
                    : 'No answer text was saved.')}
              </p>
            )}
            {message.role === 'assistant' &&
              ['cancelled', 'failed', 'interrupted'].includes(
                message.status,
              ) && (
                <p className="outcome-note">
                  {message.status === 'cancelled'
                    ? 'Stopped. This answer may be incomplete.'
                    : message.status === 'interrupted'
                      ? 'Interrupted. Check the saved result before trying again.'
                      : 'This answer did not finish. Review your question before trying again.'}
                </p>
              )}
          </article>
        ))}
      </div>
      {!atBottom && messages.length > 0 && (
        <button
          className="latest"
          type="button"
          onClick={() => {
            pinned.current = true;
            setAtBottom(true);
            panel.current!.scrollTop = panel.current!.scrollHeight;
            panel.current!.focus({ preventScroll: true });
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
