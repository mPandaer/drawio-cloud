import { afterEach, expect, test, vi } from 'vitest';
import { createEditorBridge, type SaveStatus } from './index.js';
import type { SaveFileRequest, SaveFileResponse } from '@drawio-cloud/api-contract';

const active: Array<{ dispose(): void }> = [];
afterEach(() => { active.splice(0).forEach(bridge => bridge.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(onExit?: () => void, editorOrigin = 'https://draw.example', onExitBlocked?: (error: unknown) => void) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const host = new EventTarget();
  vi.stubGlobal('window', host);
  const messages: Array<{ data: Record<string, unknown>; origin: string }> = [];
  const editor = { postMessage(data: string, origin: string) { messages.push({ data: JSON.parse(data), origin }); } } as Window;
  const requests: Array<{ request: SaveFileRequest; signal: AbortSignal; resolve(value: SaveFileResponse): void; reject(error: unknown): void }> = [];
  const statuses: SaveStatus[] = [];
  const bridge = createEditorBridge({
    clock: { now: () => Date.now(), setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    editorWindow: editor, editorOrigin,
    session: { content: '<mxfile/>', revision: 7, lease: { windowId: 'window-a', leaseToken: 'token-a' }, expiresAt: 60_000 },
    saveAdapter: { save: (request, signal) => new Promise((resolve, reject) => requests.push({ request, signal, resolve, reject })) },
    onStatus: status => statuses.push(status), onExit, onExitBlocked,
  });
  active.push(bridge);
  function send(data: unknown, origin = 'https://draw.example', source: Window = editor) {
    const event = Object.assign(new Event('message'), { data: typeof data === 'string' ? data : JSON.stringify(data), origin, source });
    host.dispatchEvent(event);
  }
  return { bridge, messages, requests, statuses, send, editor, host };
}

test('untrusted and malformed messages cannot load or change the document', () => {
  const app = setup();
  app.send({ event: 'init' }, 'https://evil.example');
  app.send({ event: 'init' }, undefined, {} as Window);
  for (const data of ['broken', 'null', '[]', '{"event":42}', '{"event":"autosave","xml":42}']) app.send(data);
  expect({ messages: app.messages, content: app.bridge.currentContent(), statuses: app.statuses }).toEqual({ messages: [], content: '<mxfile/>', statuses: [] });
});

test('changed content waits two seconds and stays unsaved until server confirmation', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>changed</mxfile>' });
  await vi.advanceTimersByTimeAsync(1999);
  expect(app.requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(app.requests[0]?.request).toEqual({ content: '<mxfile>changed</mxfile>', expectedRevision: 7, windowId: 'window-a', leaseToken: 'token-a' });
  expect(app.statuses.at(-1)).toBe('saving');
  app.requests[0].resolve({ revision: 8, size: 30, updatedAt: 2000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(app.messages.at(-1)).toEqual({ data: { action: 'status', message: '已保存', modified: false }, origin: 'https://draw.example' });
});

test('continuous changes submit the latest snapshot within ten seconds', async () => {
  const app = setup(); app.send({ event: 'init' });
  for (let second = 0; second < 10; second++) {
    app.send({ event: 'autosave', xml: `<mxfile>${second}</mxfile>` });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(app.requests.map(item => item.request.content)).toEqual(['<mxfile>9</mxfile>']);
});

test('edits during a delayed save stay dirty and submit serially with the returned revision', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  await vi.advanceTimersByTimeAsync(2000);
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(app.requests.map(item => item.request.content)).toEqual(['<mxfile>A</mxfile>']);
  app.requests[0].resolve({ revision: 8, size: 20, updatedAt: 4000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(app.statuses.slice(2)).not.toContain('saved');
  expect(app.requests[1]?.request).toMatchObject({ content: '<mxfile>B</mxfile>', expectedRevision: 8 });
  app.requests[1].resolve({ revision: 9, size: 20, updatedAt: 4000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(app.statuses.at(-1)).toBe('saved');
});

test('flush submits pending work immediately and waits through changes made during the request', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  let finished = false;
  const flushed = app.bridge.flush().then(() => { finished = true; });
  expect(app.requests[0]?.request.content).toBe('<mxfile>A</mxfile>');
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' });
  app.requests[0].resolve({ revision: 8, size: 20, updatedAt: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  expect(app.requests[1]?.request.expectedRevision).toBe(8);
  app.requests[1].resolve({ revision: 9, size: 20, updatedAt: 0 });
  await flushed;
  expect(app.bridge.currentContent()).toBe('<mxfile>B</mxfile>');
});

test('a temporary network failure rejects flush and retries the latest snapshot after a delay', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  const flushed = app.bridge.flush();
  const rejected = expect(flushed).rejects.toThrow('offline');
  app.requests[0].reject(new Error('offline'));
  await rejected;
  expect(app.statuses.at(-1)).toBe('failed');
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' });
  await vi.advanceTimersByTimeAsync(1999);
  expect(app.requests.map(item => item.request.content)).toEqual(['<mxfile>A</mxfile>']);
  await vi.advanceTimersByTimeAsync(1);
  expect(app.requests[1]?.request).toMatchObject({ content: '<mxfile>B</mxfile>', expectedRevision: 7 });
});

test.each(['UNAUTHENTICATED', 'FORBIDDEN', 'ACCOUNT_DISABLED', 'LEASE_LOST', 'REVISION_CONFLICT', 'REQUEST_TOO_LARGE', 'DOCUMENT_TOO_LARGE', 'INVALID_DOCUMENT', 'NOT_FOUND'])('%s pauses saving while preserving the downloadable current document', async code => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  const flushed = app.bridge.flush();
  const rejected = expect(flushed).rejects.toMatchObject({ error: { code } });
  app.requests[0].reject({ error: { code, message: '服务端错误' } });
  await rejected;
  expect(app.statuses.at(-1)).toBe('paused');
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' });
  app.bridge.updateLease(120_000);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(app.bridge.flush()).rejects.toMatchObject({ error: { code } });
  expect(app.requests.map(item => item.request.content)).toEqual(['<mxfile>A</mxfile>']);
  expect(app.bridge.currentContent()).toBe('<mxfile>B</mxfile>');
});

test('lease expiration pauses retry and requires confirmed renewal before saving again', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.bridge.updateLease(1000);
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(app.requests).toEqual([]);
  expect(app.statuses.at(-1)).toBe('paused');
  await expect(app.bridge.flush()).rejects.toMatchObject({ code: 'LEASE_LOST' });
  app.bridge.updateLease(60_000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(app.requests[0]?.request.content).toBe('<mxfile>A</mxfile>');
});

test('disposing a session aborts its save and prevents delayed responses or messages from changing status', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  const flushed = app.bridge.flush();
  const rejected = expect(flushed).rejects.toThrow('编辑会话已关闭');
  app.bridge.dispose();
  await rejected;
  const before = [...app.statuses];
  expect(app.requests[0].signal.aborted).toBe(true);
  app.requests[0].resolve({ revision: 8, size: 20, updatedAt: 0 });
  app.send({ event: 'autosave', xml: '<mxfile>old</mxfile>' });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(app.statuses).toEqual(before);
  expect(app.bridge.currentContent()).toBe('<mxfile>A</mxfile>');
});

test('official save-and-exit submits immediately and asks the host to leave only after confirmation', async () => {
  const exit = vi.fn(); const app = setup(exit); app.send({ event: 'init' });
  app.send({ event: 'save', xml: '<mxfile>manual</mxfile>', exit: true });
  expect(app.requests[0]?.request.content).toBe('<mxfile>manual</mxfile>');
  expect(exit).not.toHaveBeenCalled();
  app.requests[0].resolve({ revision: 8, size: 30, updatedAt: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledOnce();
  expect(app.messages.some(message => message.data.action === 'save')).toBe(false);
});

test.each(['exit', 'save'])('failed %s exit preserves the snapshot and explicitly notifies the host', async event => {
  const exit = vi.fn(); const blocked = vi.fn(); const app = setup(exit, undefined, blocked);
  app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>unsaved</mxfile>' });
  app.send(event === 'save' ? { event, xml: '<mxfile>unsaved</mxfile>', exit: true } : { event });
  const error = new Error('offline');
  app.requests[0].reject(error);
  await vi.advanceTimersByTimeAsync(0);
  expect(blocked).toHaveBeenCalledWith(error);
  expect(exit).not.toHaveBeenCalled();
  expect(app.bridge.currentContent()).toBe('<mxfile>unsaved</mxfile>');
});

test('only initialized, structurally valid events can change content or request exit', async () => {
  const exit = vi.fn(); const app = setup(exit);
  app.send({ event: 'autosave', xml: '<mxfile>early</mxfile>' });
  app.send({ event: 'exit' });
  app.send({ event: 'init' });
  app.send({ event: 'save', xml: '<mxfile>bad</mxfile>', exit: 'yes' });
  app.send({ event: 'exit', xml: 42 });
  app.send({ event: 'autosave', xml: '' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(app.bridge.currentContent()).toBe('<mxfile/>');
  expect(app.requests).toEqual([]);
  expect(exit).not.toHaveBeenCalled();
});

test('unchanged content never queues a save and repeated init cannot overwrite local edits', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile/>' });
  await app.bridge.flush(); await vi.advanceTimersByTimeAsync(10_000);
  expect(app.requests).toEqual([]);
  app.send({ event: 'autosave', xml: '<mxfile>local</mxfile>' });
  app.send({ event: 'init' });
  expect(app.messages.filter(message => message.data.action === 'load')).toHaveLength(1);
  expect(app.bridge.currentContent()).toBe('<mxfile>local</mxfile>');
});

test('renewing a valid lease does not postpone the autosave deadline', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  await vi.advanceTimersByTimeAsync(1500);
  app.bridge.updateLease(61_500);
  await vi.advanceTimersByTimeAsync(500);
  expect(app.requests[0]?.request.content).toBe('<mxfile>A</mxfile>');
});

test('lease expiration pauses immediately even while a save response is delayed', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.bridge.updateLease(3000);
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(app.statuses.at(-1)).toBe('paused');
  app.requests[0].resolve({ revision: 8, size: 20, updatedAt: 3000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(app.statuses.at(-1)).toBe('paused');
});

test('closing the page warns only while content is unconfirmed and disposal removes the warning', async () => {
  const app = setup(); app.send({ event: 'init' });
  const close = () => { const event = new Event('beforeunload', { cancelable: true }); app.host.dispatchEvent(event); return event.defaultPrevented; };
  expect(close()).toBe(false);
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  expect(close()).toBe(true);
  const flushed = app.bridge.flush();
  app.requests[0].resolve({ revision: 8, size: 20, updatedAt: 0 }); await flushed;
  expect(close()).toBe(false);
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' }); app.bridge.dispose();
  expect(close()).toBe(false);
});

test('changes during failure backoff cannot trigger an immediate retry from an old deadline', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' }); await vi.advanceTimersByTimeAsync(2000);
  app.send({ event: 'autosave', xml: '<mxfile>B</mxfile>' }); await vi.advanceTimersByTimeAsync(11_000);
  app.requests[0].reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
  app.send({ event: 'autosave', xml: '<mxfile>C</mxfile>' }); await vi.advanceTimersByTimeAsync(1000);
  expect(app.requests.map(item => item.request.content)).toEqual(['<mxfile>A</mxfile>']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(app.requests[1]?.request.content).toBe('<mxfile>C</mxfile>');
});

test('a late failed save cannot replace the lease-expired pause with a retryable status', async () => {
  const app = setup(); app.send({ event: 'init' }); app.bridge.updateLease(3000);
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' }); await vi.advanceTimersByTimeAsync(3000);
  app.requests[0].reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0);
  expect(app.statuses.at(-1)).toBe('paused');
  await vi.advanceTimersByTimeAsync(5000);
  expect(app.requests).toHaveLength(1);
});

test.each(['*', 'null', 'https://draw.example/editor'])('unsafe target origin %s is rejected before listening', origin => {
  expect(() => setup(undefined, origin)).toThrow('editorOrigin 必须是明确的 HTTP(S) origin');
});

test('a terminal failure stays identifiable after the local lease expires', async () => {
  const app = setup(); app.send({ event: 'init' });
  app.send({ event: 'autosave', xml: '<mxfile>A</mxfile>' });
  const flushed = app.bridge.flush(); const rejected = expect(flushed).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  app.requests[0].reject({ code: 'REVISION_CONFLICT' }); await rejected;
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(app.bridge.flush()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

test('editing after lease expiration retains the latest snapshot without clearing the pause', async () => {
  const app = setup(); app.send({ event: 'init' }); app.bridge.updateLease(1000);
  await vi.advanceTimersByTimeAsync(1000);
  app.send({ event: 'autosave', xml: '<mxfile>offline</mxfile>' });
  expect(app.statuses.at(-1)).toBe('paused');
  expect(app.bridge.currentContent()).toBe('<mxfile>offline</mxfile>');
});

test('init loads the native document with autosave and an explicit target origin', () => {
  const app = setup();
  app.send({ event: 'init' });
  expect(app.messages).toContainEqual({ data: { action: 'load', xml: '<mxfile/>', autosave: 1, saveAndExit: '0' }, origin: 'https://draw.example' });
});
