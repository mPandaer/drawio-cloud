import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const exec = promisify(execFile);

test('web workspace 可由原生 Node 按包名消费编辑器桥接', async () => {
  const result = await exec(process.execPath, ['--input-type=module', '-e',
    "import { createEditorBridge } from '@drawio-cloud/editor-bridge'; if (typeof createEditorBridge !== 'function') process.exit(1);",
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  expect(result.stderr).toBe('');
});
