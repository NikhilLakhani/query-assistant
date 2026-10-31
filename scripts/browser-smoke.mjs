// Optional real-browser check against the isolated integration database only.
// Uses a fresh Chrome profile and a deterministic provider, never the real key.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer as createSocketServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from '../backend/dist/app.js';
import { parseConfig } from '../backend/dist/config.js';
import { createDatabase } from '../backend/dist/storage/database.js';
import { hashPassword } from '../backend/dist/auth/password.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url?.endsWith('/query_assistant_test') ||
  process.env.QUERY_ASSISTANT_ISOLATED_TEST !== '1'
)
  throw new Error('Use the isolated integration harness with --browser-check.');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.artifacts/browser-step9');
await mkdir(output, { recursive: true });
const db = createDatabase(url);
let app, vite, chrome, ws;
const pending = new Map();
let nextId = 0;
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command timed out: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject,
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert.ok(!value.exceptionDetails, 'Browser evaluation failed.');
  return value.result.value;
}
async function until(expression) {
  for (let n = 0; n < 150; n++) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // Navigation replaces the execution context; wait for the new document.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(
    join(output, 'failure-state.json'),
    JSON.stringify(
      await evaluate(
        '({error:document.querySelector("[role=alert]")?.textContent,pending:Boolean(document.querySelector(".recovery")),activity:document.querySelector(".activity")?.textContent,questionDisabled:document.querySelector("textarea")?.disabled})',
      ),
      null,
      2,
    ),
  );
  throw new Error(`Browser condition did not become true: ${expression}`);
}
async function type(selector, value) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp('Input.insertText', { text: value });
}
async function screenshot(name) {
  const value = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  await writeFile(join(output, name), Buffer.from(value.data, 'base64'));
}
const accessibility = [];
async function audit(label) {
  await evaluate(
    await readFile(
      fileURLToPath(
        new URL('../node_modules/axe-core/axe.min.js', import.meta.url),
      ),
      'utf8',
    ),
  );
  const violations = await evaluate(
    `axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}).then(r => r.violations.map(v => ({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)})))`,
  );
  accessibility.push({ label, violations });
  assert.deepEqual(violations, [], `Accessibility violations in ${label}`);
}
async function replaceText(selector, value) {
  await evaluate(
    `document.querySelector(${JSON.stringify(selector)}).select()`,
  );
  await cdp('Input.insertText', { text: value });
}
async function key(key, modifiers = 0) {
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key,
    windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9 }[key] ?? 0,
    modifiers,
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9 }[key] ?? 0,
    modifiers,
  });
}
async function freePort() {
  const server = createSocketServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
try {
  const candidates = [
    process.env.CHROME_BIN,
    ...(process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? ['C:/Program Files/Google/Chrome/Application/chrome.exe']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]),
  ].filter(Boolean);
  let executable;
  for (const path of candidates) {
    try {
      await access(path);
      executable = path;
      break;
    } catch {
      /* try the next known executable */
    }
  }
  assert.ok(
    executable,
    'Install Chrome or set CHROME_BIN for the optional browser check.',
  );
  const port = await freePort();
  const config = parseConfig({
    NODE_ENV: 'test',
    USER_REQUESTS_PER_MINUTE: '60', // Isolated mock fixture; runtime default remains six.
    DATABASE_URL: url,
    JWT_SIGNING_KEY:
      'synthetic-browser-signing-key-with-at-least-sixty-four-characters-for-tests',
    GEMINI_API_KEY: 'synthetic-no-network-provider',
    ACCOUNTING_INR_PER_USD: '100',
    PRICE_VERSION: 'browser-test-v1',
    FRONTEND_ORIGIN: `http://127.0.0.1:${port}`,
  });
  const password = 'synthetic-browser-test-password!';
  const user = await db.user.create({
    data: {
      username: `browser_${randomUUID().replaceAll('-', '').slice(0, 18)}`,
      passwordHash: await hashPassword(password),
    },
  });
  const calls = [];
  const provider = {
    async countTokens() {
      return 100;
    },
    async *stream(turns) {
      const result = await this.answer(turns);
      if (turns.at(-1).text === 'Wait before output')
        await new Promise((resolve) => setTimeout(resolve, 1500));
      const long = ['Long stream', 'Reload while streaming'].includes(
        turns.at(-1).text,
      );
      for (const text of result.content.match(
        long ? /[\s\S]{1,128}/gu : /[\s\S]{1,12}/gu,
      )) {
        yield { type: 'delta', text };
        await new Promise((resolve) => setTimeout(resolve, long ? 100 : 70));
      }
      yield { type: 'final', ...result };
    },
    async answer(turns) {
      calls.push(structuredClone(turns));
      if (turns.at(-1).text === 'Provider outage')
        throw new Error('PRIVATE_BROWSER_PROVIDER_DIAGNOSTIC');
      return {
        content: ['Long stream', 'Reload while streaming'].includes(
          turns.at(-1).text,
        )
          ? Array.from(
              { length: 80 },
              (_, i) =>
                `Paragraph ${i + 1}. A longer synthetic answer for scroll testing. **Readable text.**`,
            ).join('\n\n')
          : 'Synthetic UI answer <img src=x onerror="window.unsafeExecuted=true"> — नमस्ते **bold** [docs](https://example.com/docs) [bad](javascript:alert) ![pixel](https://example.com/pixel)',
        completed: true,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
      };
    },
  };
  app = buildApp(config, { logger: false, database: db, provider });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  process.env.VITE_API_BASE_URL = address;
  const require = createRequire(
    new URL('../frontend/package.json', import.meta.url),
  );
  const { createServer } = await import(
    pathToFileURL(require.resolve('vite')).href
  );
  vite = await createServer({
    root: join(root, 'frontend'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await vite.listen();
  const profile = await mkdtemp(join(tmpdir(), 'query-assistant-chrome-'));
  chrome = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let debugPort;
  for (let n = 0; n < 100; n++) {
    try {
      debugPort = Number(
        (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
          '\n',
        )[0],
      );
      if (debugPort) break;
    } catch {
      /* browser is starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(debugPort, 'Isolated headless Chrome did not start.');
  const targets = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json();
  ws = new WebSocket(
    targets.find((target) => target.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data));
    if (value.method === 'Fetch.requestPaused') {
      if (value.params.request.method === 'OPTIONS') {
        void cdp('Fetch.continueRequest', {
          requestId: value.params.requestId,
        });
        return;
      }
      void cdp('Fetch.fulfillRequest', {
        requestId: value.params.requestId,
        responseCode: 503,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          {
            name: 'Access-Control-Allow-Origin',
            value: config.FRONTEND_ORIGIN,
          },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
        body: Buffer.from(
          JSON.stringify({
            error: {
              code: 'PROVIDER_UNAVAILABLE',
              message: 'Synthetic attachment failure. Check saved history.',
              requestId: randomUUID(),
              retryable: true,
            },
          }),
        ).toString('base64'),
      });
      return;
    }
    const task = pending.get(value.id);
    if (!task) return;
    pending.delete(value.id);
    if (value.error) task.reject(new Error('Browser protocol command failed.'));
    else task.resolve(value.result);
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp('Page.navigate', { url: config.FRONTEND_ORIGIN });
  await until('Boolean(document.querySelector("input[name=username]"))');
  await audit('login');
  await type('input[name=username]', user.username);
  await type('input[name=password]', password);
  await evaluate('document.querySelector("form").requestSubmit()');
  await until('document.body.innerText.includes("Sign out")');
  await until('Boolean(document.querySelector("textarea"))');
  await type('textarea', 'First line');
  await cdp('Input.insertText', { text: '\nSecond line' });
  assert.equal(
    await evaluate('document.querySelector("textarea").value'),
    'First line\nSecond line',
  );
  assert.equal(calls.length, 0);
  await replaceText('textarea', 'x'.repeat(8001));
  assert.equal(
    await evaluate('document.querySelector("textarea").value.length'),
    8000,
  );
  await replaceText('textarea', 'Remember the synthetic browser question.');
  await key('Enter', 2);
  await evaluate(
    'document.querySelector(".composer").requestSubmit(); document.querySelector(".composer").requestSubmit()',
  );
  await until(
    'document.querySelector(".message.assistant p")?.textContent.startsWith("Synthetic") && document.querySelector("textarea").disabled',
  );
  await screenshot('streaming.png');
  await until(
    'document.querySelectorAll(".message").length === 2 && !document.querySelector("textarea").disabled',
  );
  assert.equal(
    await evaluate(
      'document.querySelectorAll(".message.assistant img").length',
    ),
    0,
  );
  assert.equal(await evaluate('Boolean(window.unsafeExecuted)'), false);
  assert.ok(
    await evaluate(
      'document.querySelector(".message.assistant").innerText.includes("नमस्ते")',
    ),
  );
  assert.equal(
    await evaluate(
      'document.querySelector(".answer-markdown strong")?.textContent',
    ),
    'bold',
  );
  assert.equal(
    await evaluate('document.querySelector(".answer-markdown a")?.rel'),
    'noopener noreferrer',
  );
  assert.equal(
    await evaluate(
      'document.querySelectorAll(".answer-markdown img, .answer-markdown a[href^=javascript]").length',
    ),
    0,
  );
  await until('document.activeElement.id === "question"');
  await audit('desktop chat');
  await type('textarea', 'Conversation draft');
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "New conversation").click()',
  );
  await type('textarea', 'New conversation draft');
  assert.equal(
    await evaluate(
      'sessionStorage.getItem("query-assistant-pending-submission")',
    ),
    null,
  );
  assert.equal(
    await evaluate(
      'Object.values(sessionStorage).some(v => v.includes("Conversation draft") || v.includes("New conversation draft"))',
    ),
    false,
  );
  await evaluate('document.querySelector("aside li button").click()');
  await until(
    'document.querySelector("textarea").value === "Conversation draft" && !document.querySelector("textarea").disabled',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "New conversation").click()',
  );
  assert.equal(
    await evaluate('document.querySelector("textarea").value'),
    'New conversation draft',
  );
  await evaluate('document.querySelector("aside li button").click()');
  await until(
    'document.querySelector("textarea").value === "Conversation draft" && !document.querySelector("textarea").disabled',
  );
  await replaceText('textarea', 'What was my previous question?');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.querySelectorAll(".message").length === 4 && !document.querySelector("textarea").disabled',
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 3);
  await screenshot('desktop.png');
  await cdp('Page.reload');
  await until(
    'performance.getEntriesByType("navigation")[0]?.type === "reload" && document.body.innerText.includes("Sign out") && Boolean(document.querySelector("aside li button"))',
  );
  await until('document.querySelectorAll(".message").length === 4');
  assert.equal(calls.length, 2);
  assert.ok(
    await evaluate(
      'document.querySelector(".allowance").innerText.includes("8 requests remaining")',
    ),
  );
  await type('textarea', 'Stop during output');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.querySelectorAll(".message.assistant").length === 3 && Array.from(document.querySelectorAll(".message.assistant p")).at(-1).textContent.startsWith("Synthetic")',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Stop answer").click()',
  );
  await until(
    '!document.querySelector("textarea").disabled && Array.from(document.querySelectorAll(".message.assistant")).at(-1).innerText.includes("cancelled")',
  );
  assert.ok(
    await evaluate(
      'Array.from(document.querySelectorAll(".message.assistant p")).at(-1).textContent.length > 0',
    ),
  );
  await screenshot('cancelled.png');
  await type('textarea', 'Wait before output');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'Boolean(Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Stop answer"))',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Stop answer").click()',
  );
  await until(
    '!document.querySelector("textarea").disabled && Array.from(document.querySelectorAll(".message.assistant")).at(-1).innerText.includes("cancelled")',
  );
  await evaluate('window.beforeSecondReload = true');
  await cdp('Page.reload');
  await until(
    '!window.beforeSecondReload && Boolean(document.querySelector("aside li button"))',
  );
  await until('document.querySelectorAll(".message").length === 8');
  assert.equal(calls.length, 4);
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll(".message.assistant")).filter(m => m.innerText.includes("cancelled")).length',
    ),
    2,
  );
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await audit('mobile chat');
  await screenshot('mobile.png');
  await until('document.documentElement.scrollWidth <= window.innerWidth');
  await replaceText('textarea', 'Provider outage');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    '!document.querySelector("textarea").disabled && Array.from(document.querySelectorAll(".message.assistant")).at(-1).innerText.includes("failed")',
  );
  assert.equal(
    await evaluate('document.querySelector("textarea").value'),
    'Provider outage',
  );
  assert.equal(
    await evaluate(
      'document.body.innerText.includes("PRIVATE_BROWSER_PROVIDER_DIAGNOSTIC")',
    ),
    false,
  );
  assert.equal(calls.length, 5);
  await screenshot('provider-failure.png');
  await audit('failed answer');
  const used = await db.generationRequest.count({
    where: { userId: user.id, dispatchedAt: { not: null } },
  });
  await db.userQuota.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      dailyRequests: used,
      dailyTokens: 100000,
      dailyCostNanoInr: 100000000000n,
    },
    update: { dailyRequests: used },
  });
  await replaceText('textarea', 'Quota question');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.body.innerText.includes("daily allowance is exhausted") && !document.querySelector("textarea").disabled',
  );
  assert.equal(
    await evaluate('document.querySelector("textarea").value'),
    'Quota question',
  );
  assert.equal(
    await evaluate('Boolean(document.querySelector(".recovery"))'),
    false,
  );
  assert.equal(calls.length, 5);
  await audit('quota exhaustion');
  await screenshot('quota.png');
  await db.userQuota.update({
    where: { userId: user.id },
    data: { dailyRequests: 10 },
  });
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Refresh allowance").click()',
  );
  await until(
    '!document.body.innerText.includes("daily allowance is exhausted") && !document.querySelector("textarea").disabled',
  );
  await replaceText('textarea', 'Long stream');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.querySelector(".messages").scrollHeight > document.querySelector(".messages").clientHeight+300 && document.querySelector("textarea").disabled',
  );
  await evaluate(
    'document.querySelector(".messages").scrollTop=0; document.querySelector(".messages").dispatchEvent(new Event("scroll")); window.beforeScrollLength = Array.from(document.querySelectorAll(".message.assistant")).at(-1).textContent.length',
  );
  await until(
    'Array.from(document.querySelectorAll(".message.assistant")).at(-1).textContent.length > window.beforeScrollLength+250',
  );
  assert.ok(
    await evaluate('document.querySelector(".messages").scrollTop < 20'),
  );
  await screenshot('reading-older-during-stream.png');
  await evaluate('document.querySelector(".latest").click()');
  assert.ok(
    await evaluate(
      'document.querySelector(".messages").scrollHeight-document.querySelector(".messages").clientHeight-document.querySelector(".messages").scrollTop < 64',
    ),
  );
  await until('!document.querySelector("textarea").disabled');
  await replaceText('textarea', 'Reload while streaming');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.querySelector("textarea").disabled && Array.from(document.querySelectorAll(".message.assistant")).at(-1).querySelector(".message-meta span").textContent === "streaming" && Array.from(document.querySelectorAll(".message.assistant")).at(-1).textContent.includes("Paragraph 1")',
  );
  assert.equal(calls.length, 7);
  await evaluate('window.beforeRecoveryReload=true');
  await cdp('Page.reload');
  await until(
    '!window.beforeRecoveryReload && Boolean(document.querySelector(".recovery")) && !document.querySelector(".recovery button").disabled',
  );
  assert.equal(calls.length, 7);
  await evaluate('document.querySelector(".recovery button").click()');
  await until(
    '!document.querySelector(".recovery") && !document.querySelector("textarea").disabled',
  );
  assert.equal(calls.length, 7);
  await cdp('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/generations/*/events', requestStage: 'Request' },
    ],
  });
  await replaceText('textarea', 'Attachment failure');
  await evaluate('document.querySelector(".composer").requestSubmit()');
  await until(
    'document.body.innerText.includes("Synthetic attachment failure") && Boolean(document.querySelector(".recovery")) && !document.querySelector(".recovery button").disabled',
  );
  await cdp('Fetch.disable');
  assert.equal(calls.length, 7);
  await evaluate('document.querySelector(".recovery button").click()');
  await until(
    'document.body.innerText.includes("still in progress") && !document.querySelector(".recovery button").disabled',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Stop answer").click()',
  );
  await until(
    '!document.querySelector(".recovery") && !document.querySelector("textarea").disabled',
  );
  assert.equal(calls.length, 7);
  const mainChatId = (
    await db.conversation.findFirst({ where: { userId: user.id } })
  ).id;
  const fixtureChat = await db.conversation.create({
    data: { userId: user.id, title: 'Pagination fixture', nextSequence: 121 },
  });
  await db.message.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      conversationId: fixtureChat.id,
      sequence: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      content: `Historical fixture message ${i + 1}`,
      status: 'completed',
    })),
  });
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Refresh allowance").click()',
  );
  await until(
    'Array.from(document.querySelectorAll("aside li button")).some(b=>b.textContent.includes("Pagination fixture")) && !document.querySelector("textarea").disabled',
  );
  await evaluate('document.querySelector(".nav-toggle").click()');
  await evaluate(
    'Array.from(document.querySelectorAll("aside li button")).find(b=>b.textContent.includes("Pagination fixture")).click()',
  );
  await until(
    'document.querySelector("#chat-title").textContent === "Pagination fixture" && !document.querySelector("textarea").disabled',
  );
  await evaluate(
    'document.querySelector(".messages").scrollTop=0; document.querySelector(".messages").dispatchEvent(new Event("scroll")); window.olderAnchor = document.querySelector(".message"); window.anchorY=window.olderAnchor.getBoundingClientRect().top; window.oldMessageCount=document.querySelectorAll(".message").length',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Earlier messages").click()',
  );
  await until(
    'document.querySelectorAll(".message").length > window.oldMessageCount && !document.querySelector("textarea").disabled',
  );
  assert.ok(
    Math.abs(
      await evaluate(
        'window.olderAnchor.getBoundingClientRect().top-window.anchorY',
      ),
    ) < 3,
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Delete conversation").click()',
  );
  await until('document.querySelector("dialog").open');
  await audit('delete confirmation');
  await key('Escape');
  await until('!document.querySelector("dialog").open');
  assert.equal(await evaluate('document.querySelector("dialog").open'), false);
  assert.equal(
    await db.conversation.count({ where: { id: fixtureChat.id } }),
    1,
  );
  const usageCount = await db.usageRecord.count({
    where: { generation: { userId: user.id } },
  });
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Delete conversation").click()',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent === "Delete messages").click()',
  );
  await until(
    'document.body.innerText.includes("Conversation deleted") && !document.querySelector("textarea").disabled',
  );
  assert.equal(
    await db.message.count({ where: { conversationId: fixtureChat.id } }),
    0,
  );
  assert.equal(
    await db.usageRecord.count({ where: { generation: { userId: user.id } } }),
    usageCount,
  );
  await evaluate('document.querySelector(".nav-toggle").click()');
  await evaluate('document.querySelector("aside li button").click()');
  await until(
    'document.querySelectorAll(".message").length > 0 && !document.querySelector("textarea").disabled',
  );
  assert.ok(await db.conversation.findUnique({ where: { id: mainChatId } }));
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Sign out").click()',
  );
  await until(
    'Boolean(document.querySelector("input[name=password]")) && !document.body.innerText.includes("Sign out")',
  );
  assert.equal(
    await evaluate('document.querySelectorAll(".message").length'),
    0,
  );
  await vite.close();
  const { build, preview } = await import(
    pathToFileURL(require.resolve('vite')).href
  );
  const productionOutput = join(output, 'production');
  await build({
    root: join(root, 'frontend'),
    logLevel: 'error',
    build: { outDir: productionOutput, emptyOutDir: true },
  });
  vite = await preview({
    root: join(root, 'frontend'),
    logLevel: 'error',
    build: { outDir: productionOutput },
    preview: { host: '127.0.0.1', port, strictPort: true },
  });
  await cdp('Page.navigate', { url: config.FRONTEND_ORIGIN + '?production=1' });
  await until(
    'location.search === "?production=1" && Boolean(document.querySelector("input[name=username]"))',
  );
  const policy = await evaluate(
    'document.querySelector("meta[http-equiv=Content-Security-Policy]")?.content',
  );
  assert.ok(policy.includes("script-src 'self'") && policy.includes(address));
  await type('input[name=username]', user.username);
  await type('input[name=password]', password);
  await evaluate('document.querySelector("form").requestSubmit()');
  await until('document.body.innerText.includes("Sign out")');
  // Step 9 exercises the production bundle against the same isolated database.
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Administration")',
    ),
    false,
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Sign out").click()',
  );
  await until('Boolean(document.querySelector("input[name=username]"))');
  // The completed chat phase has exercised many CSRF/login operations. Start
  // this separate admin phase with a fresh burst window; runtime policy stays 30.
  await app.close();
  app = buildApp(config, { database: db, provider, logger: false });
  await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) });
  const adminUser = await db.user.create({
    data: {
      username: `adm_${randomUUID().replaceAll('-', '').slice(0, 18)}`,
      passwordHash: await hashPassword(password),
      role: 'admin',
    },
  });
  const applicant = await db.accessRequest.create({
    data: { username: `new_${randomUUID().replaceAll('-', '').slice(0, 18)}` },
  });
  await type('input[name=username]', adminUser.username);
  await type('input[name=password]', password);
  await evaluate('document.querySelector("form").requestSubmit()');
  await until(
    'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Administration")',
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Administration").click()',
  );
  await until(
    'Boolean(document.querySelector(".usage-summary")) && !document.querySelector(".admin [role=status]")',
  );
  await audit('admin dashboard production');
  await screenshot('admin-mobile.png');
  assert.equal(
    await evaluate('document.documentElement.scrollWidth<=innerWidth'),
    true,
  );
  await replaceText('.admin-filters input[name=userId]', user.id);
  await evaluate('document.querySelector(".admin-filters").requestSubmit()');
  await until(
    `document.querySelector(".admin .usage-summary")?.textContent.includes("${await db.generationRequest.count({ where: { userId: user.id } })} requests")`,
  );
  const targetExpression = `Array.from(document.querySelectorAll('.admin article')).find(a=>a.querySelector('h3')?.textContent===${JSON.stringify(user.username + ' · user')})`;
  await evaluate(
    `${targetExpression}.setAttribute('data-fixture-account','target')`,
  );
  await replaceText('[data-fixture-account] input[name=dailyRequests]', '9');
  await type(
    '[data-fixture-account] form:nth-of-type(2) input[name=reason]',
    'Synthetic browser quota edit',
  );
  await evaluate(
    'document.querySelector("[data-fixture-account] form:nth-of-type(2)").requestSubmit()',
  );
  await until('Boolean(document.querySelector(".admin dialog[open]"))');
  await audit('admin change confirmation');
  await evaluate(
    'document.querySelector(".admin dialog button.primary").click()',
  );
  await until(
    'document.querySelector(".admin [role=status]")?.textContent.includes("Change saved and persisted")',
  );
  assert.equal(
    (await db.userQuota.findUniqueOrThrow({ where: { userId: user.id } }))
      .dailyRequests,
    9,
  );
  assert.equal(
    await db.adminAuditEvent.count({
      where: { targetUserId: user.id, action: 'quota_changed' },
    }),
    1,
  );
  const requestExpression = `Array.from(document.querySelectorAll('.admin article')).find(a=>a.querySelector('h3')?.textContent===${JSON.stringify(applicant.username + ' · pending')})`;
  await evaluate(
    `${requestExpression}.setAttribute('data-fixture-request','target')`,
  );
  await type(
    '[data-fixture-request] input[name=reason]',
    'Synthetic browser approval',
  );
  await evaluate(
    'document.querySelector("[data-fixture-request] button[value=approve]").click()',
  );
  await until('Boolean(document.querySelector(".admin dialog[open]"))');
  await evaluate(
    'document.querySelector(".admin dialog button.primary").click()',
  );
  await until(
    'Boolean(document.querySelector(".admin .recovery input")) && document.querySelector(".admin [role=status]")?.textContent.includes("Change saved and persisted")',
  );
  const activationCode = await evaluate(
    'document.querySelector(".admin .recovery input").value',
  );
  assert.equal(
    await evaluate(
      `JSON.stringify(sessionStorage).includes(${JSON.stringify(activationCode)})`,
    ),
    false,
  );
  assert.equal(
    await db.user.count({ where: { username: applicant.username } }),
    0,
    'Approval alone cannot create an account',
  );
  await evaluate(
    'Array.from(document.querySelectorAll(".admin button")).find(b=>b.textContent==="Dismiss activation code").click()',
  );
  assert.equal(
    await evaluate('Boolean(document.querySelector(".admin .recovery input"))'),
    false,
  );
  await evaluate(
    `${targetExpression}.setAttribute('data-fixture-account','target')`,
  );
  await evaluate(
    'document.querySelector("[data-fixture-account] select[name=status]").value="suspended"',
  );
  await type(
    '[data-fixture-account] form:nth-of-type(1) input[name=reason]',
    'Synthetic browser suspension',
  );
  await evaluate(
    'document.querySelector("[data-fixture-account] form:nth-of-type(1)").requestSubmit()',
  );
  await until('Boolean(document.querySelector(".admin dialog[open]"))');
  await evaluate(
    'document.querySelector(".admin dialog button.primary").click()',
  );
  await until(
    'document.querySelector(".admin [role=status]")?.textContent.includes("Change saved and persisted")',
  );
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).status,
    'suspended',
  );
  assert.equal(
    await db.session.count({ where: { userId: user.id, revokedAt: null } }),
    0,
  );
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await audit('admin desktop production');
  await screenshot('admin-desktop.png');
  const adminCalls = calls.length;
  assert.equal(
    adminCalls,
    7,
    'Read-only reporting and administration never invoke the provider',
  );
  const result = {
    passed: true,
    browser: 'isolated headless Chrome',
    provider: 'deterministic mock; no real calls',
    scenarios: [
      'cookie login and CSRF',
      'question and follow-up display',
      'progressive text visible before completion',
      'Stop before output and during output, cancelled history after reload',
      'escaped HTML and Unicode',
      'reload and saved history',
      'durable allowance display',
      '390px width without horizontal overflow',
      'logout clears private display',
      'safe Markdown, disabled active links and remote images',
      'provider failure preserves draft and displays no diagnostics',
      'production build CSP permits assets and authenticated API',
      'keyboard submission, multiline/character bound, rapid-submit guard',
      'separate in-memory drafts and read-only selected-conversation restore',
      'quota rejection preserves draft without an unresolved marker',
      'scroll remains on older text, jump to latest, pagination anchor',
      'reload during streaming recovers by GET without new provider calls',
      'failed attachment retains recovery marker and cancels before provider dispatch',
      'mobile navigation and confirmed deletion preserve usage',
      'axe WCAG A/AA checks on login, desktop/mobile chat, failure, quota and dialog',
      'admin-only navigation and production dashboard filters, reports, budgets and prices',
      'confirmed audited quota change and access approval with memory-only activation code',
      'confirmed suspension invalidates sessions without provider calls',
      'admin desktop/mobile and confirmation selected-rule accessibility scans',
    ],
    generationCalls: calls.length,
    accessibility,
  };
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    'Headless browser check passed: login, question/follow-up, escaped text, reload, allowance, mobile width, and logout. Provider was a deterministic mock.',
  );
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) {
    const closed = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  for (const task of pending.values()) task.resolve({});
  pending.clear();
  if (vite?.close) await vite.close();
  else if (vite?.httpServer)
    await new Promise((resolve) => vite.httpServer.close(resolve));
  await app?.close();
  await db.$disconnect();
}
