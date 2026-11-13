'use strict';

const { parseArticleUrl, isBlockedIPv4 } = require('../src/utils/articleUrl');

describe('parseArticleUrl', () => {
  test('accepts normal article URLs and strips fragments', () => {
    const result = parseArticleUrl('  https://News.Example.com/2025/story?id=7#comments  ');
    expect(result.url).toBe('https://news.example.com/2025/story?id=7');
    expect(result.hostname).toBe('news.example.com');
  });

  test('normalizes for duplicate detection: case, default port, trailing slash, tracking params', () => {
    const variants = [
      'https://example.com/a/story',
      'https://EXAMPLE.com:443/a/story/',
      'https://example.com/a/story?utm_source=x&utm_medium=y',
      'https://example.com/a/story?fbclid=abc#top',
      'https://example.com./a/story',
    ];
    const normalized = new Set(variants.map((url) => parseArticleUrl(url).normalizedUrl));
    expect([...normalized]).toEqual(['https://example.com/a/story']);
  });

  test('keeps meaningful query parameters', () => {
    expect(parseArticleUrl('https://example.com/read?article=12&utm_campaign=z').normalizedUrl).toBe(
      'https://example.com/read?article=12'
    );
  });

  test.each([
    ['', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['example.com/article', 'INVALID_URL'],
    ['ftp://example.com/file', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['file:///etc/passwd', 'INVALID_URL'],
    ['data:text/html,hello', 'INVALID_URL'],
    ['https://exa mple.com/', 'INVALID_URL'],
    [`https://example.com/${'a'.repeat(2100)}`, 'INVALID_URL'],
    ['http://localhost:80/admin', 'UNSAFE_URL'],
    ['http://api.localhost/', 'UNSAFE_URL'],
    ['http://printer.local/', 'UNSAFE_URL'],
    ['http://metadata.google.internal/', 'UNSAFE_URL'],
    ['http://redis/', 'UNSAFE_URL'],
    ['http://127.0.0.1/', 'UNSAFE_URL'],
    ['http://127.1/', 'UNSAFE_URL'],
    ['http://2130706433/', 'UNSAFE_URL'],
    ['http://0x7f000001/', 'UNSAFE_URL'],
    ['http://10.1.2.3/', 'UNSAFE_URL'],
    ['http://172.20.0.1/', 'UNSAFE_URL'],
    ['http://192.168.0.10/', 'UNSAFE_URL'],
    ['http://169.254.169.254/latest/meta-data/', 'UNSAFE_URL'],
    ['http://100.64.1.1/', 'UNSAFE_URL'],
    ['http://0.0.0.0/', 'UNSAFE_URL'],
    ['http://[::1]/', 'UNSAFE_URL'],
    ['http://[::ffff:127.0.0.1]/', 'UNSAFE_URL'],
    ['https://user:pass@example.com/', 'UNSAFE_URL'],
    ['https://example.com:8443/', 'UNSAFE_URL'],
    ['http://example.com:6379/', 'UNSAFE_URL'],
  ])('rejects %p with %s', (input, code) => {
    expect(() => parseArticleUrl(input)).toThrow(expect.objectContaining({ statusCode: 400, code }));
  });

  test('rejects non-string input', () => {
    expect(() => parseArticleUrl(undefined)).toThrow(expect.objectContaining({ code: 'INVALID_URL' }));
    expect(() => parseArticleUrl({ url: 'x' })).toThrow(expect.objectContaining({ code: 'INVALID_URL' }));
  });

  test('allows public IPv4 literals', () => {
    expect(parseArticleUrl('http://93.184.216.34/page').hostname).toBe('93.184.216.34');
  });
});

describe('isBlockedIPv4', () => {
  test.each([
    ['127.0.0.1', true],
    ['10.255.255.255', true],
    ['172.15.0.1', false],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
  ])('%s -> %s', (ip, blocked) => {
    expect(isBlockedIPv4(ip)).toBe(blocked);
  });
});
