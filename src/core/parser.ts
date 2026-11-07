import { compareRefs } from './keys.js';
import type { IssueRef, RawRelation } from './types.js';

export interface KeywordConfig {
  blockedBy: string[];
  blocks: string[];
}

export const DEFAULT_KEYWORDS: KeywordConfig = {
  blockedBy: ['depends on', 'blocked by', 'requires', 'dependencies'],
  blocks: ['blocks', 'blocking', 'required by'],
};

export interface ParseOptions {
  keywords?: KeywordConfig;
  /** Hostnames accepted in URL references (e.g. ['github.com']). Empty or undefined: URLs are ignored. */
  webHosts?: string[];
  /** When true, read only `Blocked by: [...]` / `Parent: [...]` relation lines and ignore the keyword-line and section forms. */
  strict?: boolean;
}

export interface ClosingParseOptions {
  /** Hostnames accepted in URL references (e.g. ['github.com']). Empty or undefined: URLs are ignored. */
  webHosts?: string[];
}

type Kind = RawRelation['kind'];

interface KeywordEntry {
  /** Lowercased, single-spaced. */
  text: string;
  kind: Kind;
}

/** Placeholder for an inline code span: not a word character, not whitespace. */
const CODE_PLACEHOLDER = '\u0001';

const WORD = '\\p{L}\\p{N}_';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyword(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Deduplicated keyword entries, longest first (ties: blocked-by first, then code-unit order). */
function buildKeywords(config: KeywordConfig): KeywordEntry[] {
  const seen = new Set<string>();
  const entries: KeywordEntry[] = [];
  const add = (list: string[] | undefined, kind: Kind): void => {
    for (const raw of list ?? []) {
      const text = normalizeKeyword(raw);
      if (text === '' || seen.has(text)) continue;
      seen.add(text);
      entries.push({ text, kind });
    }
  };
  add(config.blockedBy, 'blocked-by');
  add(config.blocks, 'blocks');
  entries.sort((a, b) => {
    if (a.text.length !== b.text.length) return b.text.length - a.text.length;
    if (a.kind !== b.kind) return a.kind === 'blocked-by' ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
  return entries;
}

interface AllowedWebRoot {
  host: string;
  /** Lowercased path prefix without leading/trailing `/`; empty for a root-hosted source. */
  subpath: string;
}

function parseWebRoots(webHosts: readonly string[] | undefined): AllowedWebRoot[] {
  const out: AllowedWebRoot[] = [];
  for (const raw of webHosts ?? []) {
    const entry = raw.trim();
    if (entry === '') continue;
    if (/^https?:\/\//i.test(entry)) {
      try {
        const u = new URL(entry);
        const host = u.host.toLowerCase();
        const subpath = u.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
        if (host !== '') out.push({ host, subpath });
      } catch {
        // Ignore malformed URL entries.
      }
      continue;
    }
    const trimmed = entry.replace(/\/+$/, '').toLowerCase();
    if (trimmed === '') continue;
    const slash = trimmed.indexOf('/');
    if (slash < 0) {
      out.push({ host: trimmed, subpath: '' });
    } else {
      const host = trimmed.slice(0, slash);
      const subpath = trimmed.slice(slash + 1).replace(/^\/+/, '');
      if (host !== '') out.push({ host, subpath });
    }
  }
  return out;
}

function matchesWebRoot(
  roots: readonly AllowedWebRoot[],
  rawHost: string,
  rawSubpath: string | undefined,
): boolean {
  const host = rawHost.toLowerCase();
  const subpath = (rawSubpath ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return roots.some((r) => r.host === host && r.subpath === subpath);
}

interface LineState {
  inComment: boolean;
  codeSpanEnd: { line: number; col: number } | null;
}

/** Markdown indentation uses four-column tab stops, including inside list containers. */
function bodyLines(body: string): string[] {
  return body.split(/\r\n|\r|\n/).map((line) => {
    let column = 0;
    return line.replace(/[^\t]+|\t/g, (part) => {
      const width = part === '\t' ? 4 - (column % 4) : part.length;
      column += width;
      return part === '\t' ? ' '.repeat(width) : part;
    });
  });
}

function findBacktickClose(line: string, start: number, length: number): number {
  let j = start;
  while (j < line.length) {
    if (line[j] !== '`') {
      j++;
      continue;
    }
    let m = 1;
    while (line[j + m] === '`') m++;
    if (m === length) return j + m;
    j += m;
  }
  return -1;
}

function isFenceOpenLine(raw: string): { char: string; length: number } | null {
  const open = FENCE_OPEN_RE.exec(raw);
  if (!open) return null;
  const marker = open[1]!;
  // A backtick fence's info string cannot contain backticks (that is an inline span).
  if (marker[0] === '`' && open[2]!.includes('`')) return null;
  return { char: marker[0]!, length: marker.length };
}

function listItemContent(raw: string): {
  text: string;
  listIndent: number;
  itemIndent: number | null;
} {
  let text = raw;
  let listIndent = 0;
  let itemIndent: number | null = null;
  for (;;) {
    const item = INLINE_LIST_ITEM_RE.exec(text);
    if (item === null) break;
    itemIndent = listIndent + item[1]!.length;
    listIndent += item[0].length;
    text = text.slice(item[0].length);
  }
  return { text, listIndent, itemIndent };
}

function isInlineBlockBoundary(raw: string, openingLine: string): boolean {
  const openingItem = listItemContent(openingLine);
  // Markdown block indentation is relative to the containing list item.
  const block = raw.startsWith(' '.repeat(openingItem.listIndent))
    ? raw.slice(openingItem.listIndent)
    : raw;
  const nextItem = INLINE_LIST_ITEM_RE.exec(raw);
  const nestedItem = INLINE_LIST_ITEM_RE.exec(block);
  // A sibling item ends an existing list paragraph regardless of its number.
  // To interrupt ordinary paragraph text, a new ordered list must start at 1
  // and its first item (like a bullet item) must have nonblank content.
  const listBoundary =
    (nextItem !== null &&
      openingItem.itemIndent !== null &&
      nextItem[1]!.length <= openingItem.itemIndent) ||
    (nestedItem !== null &&
      (nestedItem[2] === undefined || Number(nestedItem[2]) === 1) &&
      /\S/.test(block.slice(nestedItem[0].length)));
  return (
    /^\s*$/.test(block) ||
    isFenceOpenLine(block) !== null ||
    /^\s*>/.test(block) ||
    HEADING_RE.test(block) ||
    THEMATIC_BREAK_RE.test(block) ||
    SETEXT_UNDERLINE_RE.test(block) ||
    listBoundary
  );
}

/** Retains list context when a backtick opens on a paragraph's continuation line. */
function inlineParagraphOpeningLine(lines: readonly string[], lineIndex: number): string {
  let start = lineIndex;
  while (start > 0) {
    const previous = lines[start - 1]!;
    if (isInlineBlockBoundary(previous, '')) {
      if (INLINE_LIST_ITEM_RE.test(previous)) start--;
      break;
    }
    start--;
  }
  let openingLine = lines[start]!;
  for (let k = start + 1; k <= lineIndex; k++) {
    if (isInlineBlockBoundary(lines[k]!, openingLine)) openingLine = lines[k]!;
  }
  return openingLine;
}

/**
 * Removes HTML comments (replaced by a space) and inline code spans (replaced by a
 * placeholder) from one line. Comment and multiline inline code-span state carry over
 * to following lines within the same paragraph/block.
 */
function cleanLine(lines: readonly string[], lineIndex: number, state: LineState): string {
  const line = lines[lineIndex]!;
  let out = '';
  let i = 0;
  if (state.codeSpanEnd !== null) {
    if (lineIndex < state.codeSpanEnd.line) return CODE_PLACEHOLDER;
    out = CODE_PLACEHOLDER;
    i = state.codeSpanEnd.col;
    state.codeSpanEnd = null;
  }
  if (state.inComment) {
    const end = line.indexOf('-->', i);
    if (end < 0) return out + ' ';
    state.inComment = false;
    out += ' ';
    i = end + 3;
  }
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '<' && line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      out += ' ';
      if (end < 0) {
        state.inComment = true;
        return out;
      }
      i = end + 3;
    } else if (ch === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      const sameLineClose = findBacktickClose(line, i + n, n);
      if (sameLineClose >= 0) {
        out += CODE_PLACEHOLDER;
        i = sameLineClose;
      } else {
        let multilineClose: { line: number; col: number } | null = null;
        if (!HEADING_RE.test(line)) {
          const openingLine = inlineParagraphOpeningLine(lines, lineIndex);
          for (let k = lineIndex + 1; k < lines.length; k++) {
            const nextLine = lines[k]!;
            if (isInlineBlockBoundary(nextLine, openingLine)) break;
            const col = findBacktickClose(nextLine, 0, n);
            if (col >= 0) {
              multilineClose = { line: k, col };
              break;
            }
          }
        }
        if (multilineClose !== null) {
          state.codeSpanEnd = multilineClose;
          out += CODE_PLACEHOLDER;
          return out;
        }
        out += line.slice(i, i + n);
        i += n;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`+|~+)\s*$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+\.)\s+/;
/** List items for inline block boundaries, including CommonMark's 1–9 digit limit. */
const INLINE_LIST_ITEM_RE = /^( {0,3})(?:[-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/** Fences and quotes may start at the content of one or more nested list items. */
function closingBlockContent(
  lines: readonly string[],
  lineIndex: number,
): { text: string; listIndent: number } {
  const raw = lines[lineIndex]!;
  const content = listItemContent(raw);
  // Ordinary prose/list text needs no paragraph lookbehind here.
  if (content.listIndent === 0 || !/^\s*(?:>|`{3,}|~{3,})/.test(content.text)) {
    return { text: raw, listIndent: 0 };
  }
  const openingLine = inlineParagraphOpeningLine(lines, lineIndex);
  if (isInlineBlockBoundary(raw, openingLine)) {
    return content;
  }
  return { text: raw, listIndent: 0 };
}

/**
 * A relation line: `Blocked by: [...]` or `Parent: [...]`, optionally after a list
 * marker or task checkbox. Only references inside the brackets count. The keyword is
 * fixed (not configurable) and case-insensitive.
 */
const RELATION_LINE_RE =
  /^\s*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ xX]\]\s*)?(blocked by|parent)\s*:\s*\[/i;

/** Removes surrounding `**` / `__` emphasis markers. */
function stripEmphasis(s: string): string {
  let r = s.trim();
  for (;;) {
    const next = r
      .replace(/^(?:\*\*|__)/, '')
      .replace(/(?:\*\*|__)$/, '')
      .trim();
    if (next === r) return r;
    r = next;
  }
}

/** Normalizes heading text: drops closing #s, emphasis and a trailing colon. */
function headingText(raw: string | undefined): string {
  let t = (raw ?? '').trim().replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
  t = stripEmphasis(t).replace(/:$/, '');
  return normalizeKeyword(stripEmphasis(t));
}

export function parseBodyRelations(body: string, options: ParseOptions = {}): RawRelation[] {
  const keywords = buildKeywords(options.keywords ?? DEFAULT_KEYWORDS);
  if (!body) return [];
  const kindOf = new Map<string, Kind>(keywords.map((k) => [k.text, k.kind]));
  const webRoots = parseWebRoots(options.webHosts);

  const alternation = keywords.map((k) => escapeRegex(k.text).replace(/ /g, '\\s+')).join('|');
  const keywordLineRe = new RegExp(
    `^\\s*(?:(?:[-*+]|\\d+\\.)\\s+)?(?:\\[[ xX]\\]\\s*)?(?:\\*\\*|__)?(${alternation})(?:(?=__)|(?![${WORD}]))`,
    'iu',
  );

  const refRe = new RegExp(
    [
      // 1: host, 2: subpath, 3: owner, 4: repo, 5: number
      `(?<![${WORD}])https?://([A-Za-z0-9.-]+(?::\\d+)?)(?:/((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+))?/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\\d+)(?![${WORD}])`,
      // 6: owner, 7: repo, 8: number
      `(?<![${WORD}])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\\d+)(?![${WORD}])`,
      // 9: number
      `(?<![${WORD}/])#(\\d+)(?![${WORD}])`,
    ].join('|'),
    'gu',
  );

  const found = new Map<string, RawRelation>();
  const addRefs = (text: string, kind: Kind): void => {
    for (const m of text.matchAll(refRe)) {
      let owner: string | null = null;
      let repo: string | null = null;
      let numText: string;
      if (m[5] !== undefined) {
        if (!matchesWebRoot(webRoots, m[1]!, m[2])) continue;
        owner = m[3]!.toLowerCase();
        repo = m[4]!.toLowerCase();
        numText = m[5];
      } else if (m[8] !== undefined) {
        owner = m[6]!.toLowerCase();
        repo = m[7]!.toLowerCase();
        numText = m[8];
      } else {
        numText = m[9]!;
      }
      const number = Number(numText);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      const id = `${kind}|${owner ?? ''}/${repo ?? ''}#${number}`;
      if (!found.has(id)) {
        found.set(id, { kind, ref: { owner, repo, number }, source: 'body' });
      }
    }
  };

  const lineState: LineState = { inComment: false, codeSpanEnd: null };
  let fence: { char: string; length: number } | null = null;
  let section: Kind | null = null;
  const lines = bodyLines(body);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]!;
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (!lineState.inComment && lineState.codeSpanEnd === null) {
      const opened = isFenceOpenLine(raw);
      if (opened) {
        fence = opened;
        continue;
      }
    }

    const line = cleanLine(lines, lineIndex, lineState);
    if (/^\s*>/.test(line)) continue;

    // A relation line is read in every mode; when it has this shape, only the
    // references inside its brackets count (text after `]` is a human note).
    const relation = RELATION_LINE_RE.exec(line);
    if (relation) {
      const close = line.indexOf(']', relation[0].length);
      if (close >= 0) {
        const kind: Kind = normalizeKeyword(relation[1]!) === 'parent' ? 'parent' : 'blocked-by';
        addRefs(line.slice(relation[0].length, close), kind);
        continue;
      }
    }
    if (options.strict || keywords.length === 0) continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      section = kindOf.get(headingText(heading[1])) ?? null;
      continue;
    }

    const kw = keywordLineRe.exec(line);
    if (kw) {
      const kind = kindOf.get(normalizeKeyword(kw[1]!));
      if (kind) addRefs(line.slice(kw[0].length), kind);
      continue;
    }

    if (section) {
      const marker = LIST_MARKER_RE.exec(line);
      if (marker) addRefs(line.slice(marker[0].length), section);
    }
  }

  const kindRank = (k: Kind): number => (k === 'blocked-by' ? 0 : k === 'blocks' ? 1 : 2);
  return [...found.values()].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || compareRefs(a.ref, b.ref),
  );
}

/**
 * Extracts issue references after standard pull-request closing keywords
 * (`close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`),
 * ignoring fenced code blocks, inline code spans, HTML comments, and blockquotes.
 */
export function parseClosingIssues(body: string, options: ClosingParseOptions = {}): IssueRef[] {
  if (!body) return [];
  const webRoots = parseWebRoots(options.webHosts);
  const closingRe = new RegExp(
    `(?<![${WORD}/])(?:\\*{1,2}|_{1,2})?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:(?=(?:\\*{1,2}|_{1,2})(?![${WORD}]))|(?![${WORD}]))(?:\\*{1,2}|_{1,2})?(?:\\s*:\\s*(?:\\*{1,2}|_{1,2})?\\s*|\\s+)(?:\\[\\s*)?(?:` +
      [
        // 1: host, 2: subpath, 3: owner, 4: repo, 5: number
        `https?://([A-Za-z0-9.-]+(?::\\d+)?)(?:/((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+))?/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\\d+)(?![${WORD}])`,
        // 6: owner, 7: repo, 8: number
        `([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\\d+)(?![${WORD}])`,
        // 9: number
        `#(\\d+)(?![${WORD}])`,
      ].join('|') +
      ')',
    'giu',
  );

  const found = new Map<string, IssueRef>();
  const lineState: LineState = { inComment: false, codeSpanEnd: null };
  let fence: { char: string; length: number; listIndent: number } | null = null;
  const lines = bodyLines(body);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]!;
    // A list-contained code block ends with its item, even without a closing fence.
    if (fence && raw.trim() !== '' && /^ */.exec(raw)![0].length < fence.listIndent) {
      fence = null;
    }
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw.slice(fence.listIndent));
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (!lineState.inComment && lineState.codeSpanEnd === null) {
      const block = closingBlockContent(lines, lineIndex);
      if (/^\s*>/.test(block.text)) continue;
      const opened = isFenceOpenLine(block.text);
      if (opened) {
        fence = { ...opened, listIndent: block.listIndent };
        continue;
      }
    }

    const line = cleanLine(lines, lineIndex, lineState);
    if (/^\s*>/.test(line)) continue;

    for (const m of line.matchAll(closingRe)) {
      let owner: string | null = null;
      let repo: string | null = null;
      let numText: string;
      if (m[5] !== undefined) {
        if (!matchesWebRoot(webRoots, m[1]!, m[2])) continue;
        owner = m[3]!.toLowerCase();
        repo = m[4]!.toLowerCase();
        numText = m[5];
      } else if (m[8] !== undefined) {
        owner = m[6]!.toLowerCase();
        repo = m[7]!.toLowerCase();
        numText = m[8];
      } else {
        numText = m[9]!;
      }
      const number = Number(numText);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      const id = `${owner ?? ''}/${repo ?? ''}#${number}`;
      if (!found.has(id)) {
        found.set(id, { owner, repo, number });
      }
    }
  }

  return [...found.values()].sort(compareRefs);
}
