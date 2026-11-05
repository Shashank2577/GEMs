/**
 * @mention parsing for workspace comments (006/FR-032). Pure.
 *
 * Rules:
 *  - `@Ravi` and `@Ravi Sharma` match org members case-insensitively; each user id is returned once.
 *  - The `@` must start the text or follow a non-word character, so e-mail addresses (`ravi@sharma.in`) are ignored.
 *  - A full-name match wins over a first-name match, and at a given position only the LONGEST full-name match counts:
 *    `@Anil Kumar` mentions only "Anil Kumar", not a member named just "Anil" (members with the same longest name are all notified).
 *  - A first name shared by several members (and no full-name match) is ambiguous: NOBODY is notified, rather than
 *    pinging people who were probably not meant. The author can write `@First Last` to disambiguate.
 */
export interface MentionableMember { id: string; name: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';
const WHITESPACE = /\s+/;
const AT_SIGN = /@/g;
const NON_MENTION_PREV = new RegExp(`${WORD}|[.@]`, 'u'); // e-mail address or part of a word

/** Length of the case-insensitive match of `name` (any whitespace run between words) at `at`, ending at a word boundary; 0 if none. */
function matchLengthAt(body: string, at: number, name: string): number {
  const words = name.trim().split(WHITESPACE).filter(Boolean);
  if (!words.length) return 0;
  const re = new RegExp(`${words.map(escapeRe).join('\\s+')}(?!${WORD})`, 'iuy');
  re.lastIndex = at;
  const m = re.exec(body);
  return m ? m[0].length : 0;
}

export function parseMentions(body: string, members: MentionableMember[]): string[] {
  const out = new Set<string>();
  const atRe = new RegExp(AT_SIGN.source, 'g');
  for (let m = atRe.exec(body); m; m = atRe.exec(body)) {
    const prev = m.index === 0 ? '' : body[m.index - 1]!;
    if (prev && NON_MENTION_PREV.test(prev)) continue;
    const start = m.index + 1;
    const full = members.map((u) => ({ u, len: matchLengthAt(body, start, u.name) })).filter((x) => x.len > 0);
    if (full.length) {
      const longest = Math.max(...full.map((x) => x.len));
      full.filter((x) => x.len === longest).forEach((x) => out.add(x.u.id));
      continue;
    }
    const first = members.filter((u) => {
      const f = u.name.trim().split(WHITESPACE)[0];
      return !!f && matchLengthAt(body, start, f) > 0;
    });
    if (first.length === 1) out.add(first[0]!.id);
  }
  return [...out];
}
