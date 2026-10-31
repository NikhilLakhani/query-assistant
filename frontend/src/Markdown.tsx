import Markdown from 'react-markdown';

// Model links are untrusted; no images, local navigation, credentials, or active
// URL schemes. Explicit component behavior avoids loading remote tracking pixels.
export function safeLink(value: string) {
  for (const char of value)
    if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export function AnswerMarkdown({ content }: { content: string }) {
  return (
    <div className="answer-markdown">
      <Markdown
        skipHtml
        allowedElements={[
          'p',
          'br',
          'hr',
          'strong',
          'em',
          'del',
          'blockquote',
          'ul',
          'ol',
          'li',
          'pre',
          'code',
          'a',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
        ]}
        urlTransform={safeLink}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
