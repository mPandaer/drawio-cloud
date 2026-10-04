import { createServer } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { createApiClient } from './api.js';
import { createEditingLease } from './editing-lease.js';
import { createEditorBridge } from '@drawio-cloud/editor-bridge';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
async function rotatingLease() {
  let token = 'initial';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    if (input.leaseToken !== token) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: { code: 'LEASE_LOST' } })); return;
    }
    if (request.method === 'PATCH') {
      token = token === 'initial' ? 'renewed-once' : 'renewed-twice';
      response.end(JSON.stringify({ windowId: 'window', leaseToken: token, expiresAt: 60000 }));
    } else if (request.method === 'PUT') {
      response.end(JSON.stringify({ revision: 2, size: input.content.length, updatedAt: 0 }));
    } else { response.statusCode = 204; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP required');
  return createEditingLease(createApiClient(`http://127.0.0.1:${address.port}`), 'file', { windowId: 'window', leaseToken: 'initial', expiresAt: 60000 });
}

test('连续续租使用服务器轮换后的凭据，释放同一当前租约', async () => {
  const lease = await rotatingLease();
  await lease.renew();
  await expect(lease.renew()).resolves.toMatchObject({ leaseToken: 'renewed-twice' });
  await expect(lease.release()).resolves.toBeUndefined();
});

test('bridge 在续租后保存真实快照时使用同一当前凭据', async () => {
  const lease = await rotatingLease();
  const host = new EventTarget(); vi.stubGlobal('window', host);
  const editor = { postMessage() {} } as unknown as Window;
  const bridge = createEditorBridge({
    clock: { now: () => 0, setTimeout: () => 0, clearTimeout() {} },
    session: { content: '<mxfile/>', revision: 1, lease: lease.value, expiresAt: 60000 },
    saveAdapter: lease, editorWindow: editor, editorOrigin: 'http://localhost', onStatus() {},
  });
  try {
    await lease.renew(); bridge.updateLease(lease.value.expiresAt);
    for (const data of [{ event: 'init' }, { event: 'autosave', xml: '<mxfile>changed</mxfile>' }]) {
      host.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(data), origin: 'http://localhost', source: editor }));
    }
    await expect(bridge.flush()).resolves.toBeUndefined();
    expect(bridge.currentContent()).toBe('<mxfile>changed</mxfile>');
  } finally { bridge.dispose(); vi.unstubAllGlobals(); }
});
