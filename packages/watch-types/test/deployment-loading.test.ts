import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);

it('loads the SDK without compiling unused deployment schemas, then validates when the adapter is used', () => {
  const script = `
    const { Ajv } = await import(${JSON.stringify(pathToFileURL(require.resolve('ajv')).href)});
    await import(${JSON.stringify(new URL('../dist/plugin-model.js', import.meta.url).href)});
    let compilations = 0;
    const original = Ajv.prototype.compile;
    Ajv.prototype.compile = function (...args) { compilations++; return original.apply(this, args); };
    await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const { DeploymentWatchType } = await import(${JSON.stringify(new URL('../dist/deployment/index.js', import.meta.url).href)});
    const beforeUse = compilations;
    const adapter = new DeploymentWatchType();
    const valid = adapter.optionsSchema.parse({ fixturePath: '/fixture/history.json' });
    let rejected = false;
    try { adapter.optionsSchema.parse({ fixturePath: 7 }); } catch { rejected = true; }
    console.log(JSON.stringify({ beforeUse, afterUse: compilations, valid, rejected }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8', timeout: 15000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toMatchObject({ beforeUse: 0, valid: { fixturePath: '/fixture/history.json' }, rejected: true });
  expect(JSON.parse(result.stdout).afterUse).toBeGreaterThan(0);
});
