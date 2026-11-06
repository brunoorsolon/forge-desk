import { describe, expect, it } from 'vitest';
import { createGitHubProvider } from './github.js';
import { createGiteaProvider } from './gitea.js';

const REPO = { owner: 'acme', repo: 'api' };
const NONE = { native: false, subIssues: false };

describe.each([
  { kind: 'github', createProvider: createGitHubProvider },
  { kind: 'gitea', createProvider: createGiteaProvider },
])('$kind provider cooldownUntil', ({ createProvider }) => {
  it('reports its client cooldown with the injected clock and leaves direct reads unchanged', async () => {
    const start = 1_700_000_000_000;
    let time = start;
    let calls = 0;
    const options = {
      baseUrl: 'https://forge.example.test',
      token: null,
      now: () => time,
      fetch: async () => {
        calls++;
        if (calls === 1)
          return new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
        return new Response('[]', { headers: { 'x-total-count': '0' } });
      },
    };
    const provider = createProvider(options);
    expect(provider.cooldownUntil!()).toBeNull();
    expect(calls).toBe(0);
    await expect(provider.listOpenIssues(REPO, NONE)).rejects.toThrow(/rate limit exceeded/);
    expect(provider.cooldownUntil!()).toBe(start + 3_600_000);
    // Another source with the same origin still has its own independent client.
    expect(createProvider(options).cooldownUntil!()).toBeNull();
    time += 3_600_000 - 1;
    expect(provider.cooldownUntil!()).toBe(start + 3_600_000);
    await expect(provider.getIssue(REPO, 1)).rejects.toThrow(/rate limit exceeded/);
    expect(calls).toBe(1);
    time++;
    expect(provider.cooldownUntil!()).toBeNull();
    expect(calls).toBe(1);
    await expect(provider.listOpenIssues(REPO, NONE)).resolves.toMatchObject({ issues: [] });
    expect(provider.cooldownUntil!()).toBeNull();
    expect(calls).toBe(2);
  });
});
