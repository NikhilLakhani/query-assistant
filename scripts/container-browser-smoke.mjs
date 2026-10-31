// Packaging browser check. Imported only by the isolated Docker harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';

export async function containerBrowser({
  origin,
  ca,
  username,
  password,
  output,
  root,
}) {
  await mkdir(output, { recursive: true });
  // Verify the normal chain first; scope Chrome's test exception to this exact
  // leaf SPKI in a disposable profile, without changing the host trust store.
  const pin = await new Promise((resolve, reject) => {
    const req = https.get(origin, { ca, family: 4, agent: false }, (res) => {
      try {
        const cert = new X509Certificate(res.socket.getPeerCertificate().raw);
        res.resume();
        resolve(
          createHash('sha256')
            .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
            .digest('base64'),
        );
      } catch {
        res.resume();
        reject(
          new Error('Unable to inspect verified local TLS leaf certificate.'),
        );
      }
    });
    req.on('error', reject);
  });
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
      /* next candidate */
    }
  }
  assert.ok(
    executable,
    'Chrome or CHROME_BIN is required for --browser-check.',
  );
  const profile = await mkdtemp(join(tmpdir(), 'query-docker-chrome-'));
  const chrome = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--ignore-certificate-errors-spki-list=${pin}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let ws;
  const pending = new Map();
  let sequence = 0;
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser deadline: ${method}`));
        }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.ok(!r.exceptionDetails, 'Browser evaluation failed.');
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 150; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        /* context replaced */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Browser condition failed: ${expression}`);
  };
  const type = async (selector, text) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus()`,
    );
    await cdp('Input.insertText', { text });
  };
  const button = async (text) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
    );
  const screenshot = async (name) => {
    const r = await cdp('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(join(output, name), Buffer.from(r.data, 'base64'));
  };
  const scans = [];
  const audit = async (label) => {
    await evaluate(
      await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8'),
    );
    const violations = await evaluate(
      `axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}).then(r=>r.violations.map(v=>({id:v.id,impact:v.impact})))`,
    );
    scans.push({ label, violations });
    assert.deepEqual(violations, []);
  };
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try {
        port = Number(
          (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
            '\n',
          )[0],
        );
        if (port) break;
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(port);
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    ws = new WebSocket(
      targets.find((t) => t.type === 'page').webSocketDebuggerUrl,
    );
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (e) => {
      const value = JSON.parse(String(e.data));
      if (!value.id) return;
      const item = pending.get(value.id);
      if (!item) return;
      pending.delete(value.id);
      if (value.error) item.reject(new Error('Browser command failed.'));
      else item.resolve(value.result);
    });
    await cdp('Page.enable');
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp('Page.navigate', { url: origin });
    await until('Boolean(document.querySelector("input[name=username]"))');
    await type('input[name=username]', username);
    await type('input[name=password]', password);
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'Boolean(document.querySelector("#question")) && !document.querySelector("#question").disabled',
    );
    assert.ok(
      (await cdp('Network.getAllCookies')).cookies.some(
        (c) => c.name === '__Host-qa_session' && c.secure && c.httpOnly,
      ),
    );
    await type('#question', 'Container browser first question');
    await button('Send question');
    await until(
      'document.querySelectorAll(".message.assistant").length===1 && !document.querySelector("#question").disabled',
    );
    await type('#question', 'Container browser follow-up');
    await button('Send question');
    await until(
      'document.querySelectorAll(".message.assistant").length===2 && !document.querySelector("#question").disabled',
    );
    await cdp('Page.reload');
    await until(
      'document.querySelectorAll(".message.assistant").length===2 && !document.querySelector("#question").disabled',
    );
    await type('#question', 'Slow container answer');
    await button('Send question');
    await until(
      'document.querySelector("#stop-answer") && Array.from(document.querySelectorAll(".message.assistant")).at(-1)?.textContent.includes("Container proxy fixture")',
    );
    await evaluate('document.querySelector("#stop-answer").click()');
    await until(
      '!document.querySelector("#question").disabled && document.body.innerText.includes("cancelled")',
    );
    await audit('packaged HTTPS desktop chat');
    await screenshot('desktop.png');
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(
      await evaluate('document.documentElement.scrollWidth<=innerWidth'),
      true,
    );
    await audit('packaged HTTPS mobile chat');
    await screenshot('mobile.png');
    await button('Administration');
    await until(
      'Boolean(document.querySelector(".usage-summary")) && !document.querySelector(".admin button").disabled',
    );
    await audit('packaged HTTPS admin');
    await screenshot('admin.png');
    assert.ok(
      await evaluate(
        'document.querySelector(".admin").textContent.includes("provider-reported cost Not reported")',
      ),
    );
    await button('Sign out');
    await until('Boolean(document.querySelector("input[name=username]"))');
    assert.equal(
      await evaluate('Boolean(document.querySelector(".usage-summary"))'),
      false,
    );
    const result = {
      passed: true,
      scenarios: [
        'packaged HTTPS login with Secure HttpOnly cookie',
        'question and follow-up through proxy and persisted reload',
        'Stop during delayed mock response',
        '390px viewport without overflow',
        'admin report and estimate labels',
        'logout removes private dashboard',
      ],
      accessibility: scans,
      trust:
        'CA verified with Node; exact leaf SPKI exception in fresh Chrome profile only',
      hostTrustChanged: false,
      paidCalls: 0,
    };
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  } catch (error) {
    if (ws?.readyState === 1) await screenshot('failure.png').catch(() => {});
    throw error;
  } finally {
    ws?.close();
    for (const item of pending.values()) item.resolve({});
    pending.clear();
    if (chrome.exitCode === null) {
      const stopped = new Promise((r) => chrome.once('exit', r));
      chrome.kill('SIGTERM');
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
  }
}
