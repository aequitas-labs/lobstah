import { describe, expect, it } from 'vitest';
import { prReviewUrl, validReviewTool } from '../src/pr-review.js';

describe('review links', () => {
  const url = 'https://github.com/Acme/web/pull/42';
  it('keeps GitHub as the default, including deep links', () => {
    expect(prReviewUrl(url)).toBe(url);
    expect(prReviewUrl(url + '/files#diff')).toBe(url + '/files#diff');
  });
  it('uses verified presets and a custom HTTPS template per repo', () => {
    expect(prReviewUrl(url, { 'acme/web': 'graphite' })).toBe('https://app.graphite.com/github/pr/Acme/web/42');
    expect(prReviewUrl(url, { 'acme/web': 'linear' })).toBe('https://linear.review/Acme/web/pull/42');
    expect(prReviewUrl(url, { 'acme/web': 'linear-app' })).toBe('linear://review/Acme/web/pull/42');
    expect(prReviewUrl(url, { 'acme/web': 'https://review.example/{owner}/{repo}?pr={number}' })).toBe('https://review.example/Acme/web?pr=42');
    expect(prReviewUrl(url, { 'acme/other': 'linear' })).toBe(url);
  });
  it('never treats reports, decisions or arbitrary URLs as PRs', () => {
    for (const url of ['http://127.0.0.1:4949/report/a', '#decision/a', 'https://example.com/a/b/pull/42']) expect(prReviewUrl(url, { 'a/b': 'linear' })).toBe(url);
  });
  it('refuses unsafe or malformed templates', () => {
    for (const tool of ['javascript:alert(1)', 'linear://review/{owner}/{repo}/pull/{number}', 'other://review/{owner}/{repo}/pull/{number}', 'http://example.com/{owner}/{repo}/{number}', 'https://u:p@host/{owner}/{repo}/{number}', 'https://host/{owner}/{repo}/{number}/{unknown}', 'https://host/no-number', 'https://host/{owner}/{repo}/{number}/ has space']) {
      expect(validReviewTool(tool)).toBe(false);
      expect(prReviewUrl(url, { 'acme/web': tool })).toBe(url);
    }
  });
});
