import { describe, expect, it } from 'vitest';
import { htmlPart } from '../src/mcp/tools.js';

describe('htmlPart', () => {
  const html = 'a🌿b'; // 1 + 4 + 1 bytes

  it('returns everything by default and marks the end', () => {
    expect(htmlPart(html)).toEqual({ text: html, offset: 0, nextOffset: null });
    expect(htmlPart(html, 6)).toEqual({ text: '', offset: 6, nextOffset: null });
  });

  it('ends a part before a character it would split', () => {
    expect(htmlPart(html, 0, 3)).toEqual({ text: 'a', offset: 0, nextOffset: 1 });
    expect(htmlPart(html, 1, 4)).toEqual({ text: '🌿', offset: 1, nextOffset: 5 });
    expect(htmlPart(html, 5, 4)).toEqual({ text: 'b', offset: 5, nextOffset: null });
  });

  it('takes a character whole when the limit is smaller than it, so reading always moves on', () => {
    expect(htmlPart(html, 1, 1)).toEqual({ text: '🌿', offset: 1, nextOffset: 5 });
  });

  it('joins back to the source for every limit', () => {
    const src = '<p>Grüße – 🌿 naïve</p>\n'.repeat(5);
    for (let limit = 1; limit <= 40; limit++) {
      let out = '';
      let offset: number | null = 0;
      while (offset !== null) {
        const part = htmlPart(src, offset, limit);
        out += part.text;
        offset = part.nextOffset;
      }
      expect(out, `limit ${limit}`).toBe(src);
    }
  });

  it('refuses offsets outside the HTML or inside a character, and limits below one byte', () => {
    for (const [offset, limit] of [[-1, undefined], [7, undefined], [2, undefined], [1.5, undefined], [0, 0], [0, 2.5]] as const) {
      expect(() => htmlPart(html, offset, limit), `${offset}/${limit}`).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
  });
});
