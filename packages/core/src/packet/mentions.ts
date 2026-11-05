/**
 * @mention parsing for workspace comments (006/FR-032). Pure.
 *
 * Rules:
 *  - `@Ravi` and `@Ravi Sharma` match org members case-insensitively; each user id is returned once.
 *  - The `@` must start the text or follow a non-word character, so e-mail addresses (`ravi@sharma.in`) are ignored.
 *  - A full-name match wins over a first-name match: `@Ravi Sharma` mentions only Ravi Sharma even if another Ravi exists.
 *  - A first name shared by several members (and no full-name match) is ambiguous: NOBODY is notified, rather than
 *    pinging people who were probably not meant. The author can write `@First Last` to disambiguate.
 */
export interface MentionableMember { id: string; name: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';

/** Case-insensitive match of `name` (any whitespace run between words) at `at`, followed by a word boundary. */
function matchesAt(body: string, at: number, name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const re = new RegExp(`${words.map(escapeRe).join('\\s+')}(?!${WORD})`, 'iuy');
  re.lastIndex = at;
  return re.test(body);
}

export function parseMentions(body: string, members: MentionableMember[]): string[] {
  const out = new Set<string>();
  const at = /@/g;
  for (let m = at.exec(body); m; m = at.exec(body)) {
    const prev = m.index === 0 ? '' : body[m.index - 1]!;
    if (prev && new RegExp(`${WORD}|[.@]`, 'u').test(prev)) continue; // e-mail address or part of a word
    const start = m.index + 1;
    const full = members.filter((u) => matchesAt(body, start, u.name));
    if (full.length) { full.forEach((u) => out.add(u.id)); continue; }
    const first = members.filter((u) => {
      const f = u.name.trim().split(/\s+/)[0];
      return !!f && matchesAt(body, start, f);
    });
    if (first.length === 1) out.add(first[0]!.id);
  }
  return [...out];
}
