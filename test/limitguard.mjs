// The limit guard (068), AnyList's JavaScript port of the canonical detector `limitguard.py`
// (coordinator notes, `068-guard/`). It finds a limit-shaped value that is neither a declared
// Limit nor marked, and compares what it finds with two text files that sit beside it:
// `limitguard-todo.txt` (not yet converted) and `limitguard-tags.txt` (the registry of marks).
//
// What it reads: every file git lists and does not ignore (tracked and untracked, so a new file
// is read in the run that gates its commit), minus the skipped paths, and only under TEXT_ROOTS:
// JavaScript (`.js .mjs .cjs`), compose and other YAML, systemd units, shell, Dockerfiles.
// There is no Python in this repository, so the Python scanner is not ported.
//
// A value is marked in place with `// limit-ok: <kind> — <reason of three words or more>` (`#`
// in YAML, shell and Dockerfiles) on its own line or on a comment-only line directly above it.
// Kinds: maximum, reply-bound, format, not-a-limit, pi-guard (080: a cap that protects another
// machine from a broken-into Pi; counts only under `CONFIG.piGuards`, empty meaning nowhere). Every mark is also a line in
// `limitguard-tags.txt` as `path | scope | what | value | kind | reason`.
//
// The todo list is a multiset of `path | scope | what | value` (no line number) and hand-found
// misses as `path | anchor` (a piece of the line's text).
//
// `node test/limitguard.mjs --emit` prints every unmarked hit as a todo line; `--strict` lists
// the whole todo list and exits 1 while it is not empty.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const NON_SHIPPING = ['deploy/', 'plans/', 'spikes/'];
export const KINDS = ['maximum', 'reply-bound', 'format', 'not-a-limit', 'pi-guard'];
const STRONG = new Set(
  'timeout timeouts seconds wall deadline max cap caps bytes retries attempts limit'.split(' '));
export const TODO_NAME = 'limitguard-todo.txt';
export const TAGS_NAME = 'limitguard-tags.txt';

const WORDS = new Set(`timeout timeouts seconds secs sec ms millis minutes mins hours days wall
  deadline interval every period ttl age window delay backoff wait sleep retry retries attempt
  attempts tries max maximum min minimum limit limits cap caps ceiling budget budgets size sizes
  bytes octets kib mib gib kb mb gb pages chars length len count batch chunk workers concurrency
  parallel slots hourly daily rate quota depth hits top lines rows items keep cpu rlimit maxsize
  maxlen stale grace poll lease horizon allowance per hour day month week most longest cutoff
  expiry expires lifetime pool`.split(/\s+/));

const MALFORMED = 'a `limit-ok` comment that does not read `limit-ok: <kind> — <reason>`';
const STRAY = 'a `limit-ok` tag with no limit on its line or on the line below it';
const TAG = /limit-ok:\s*(?<kind>[A-Za-z-]+)\s*(?:—|--|-|:)\s*(?<reason>.*?)\s*$/;
const TAG_WORD = /limit-ok\b/;

export function words(name) {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return new Set(spaced.toLowerCase().split(/[_\-\s.]+/).filter(Boolean));
}
function limitish(name) {
  return !!name && [...words(name)].some((w) => WORDS.has(w));
}

// The one place that differs from the canonical Config: this repository's.
export const CONFIG = {
  root: resolve(HERE, '..'),
  guardDir: HERE,
  skip: ['test/', 'tests/', 'evals/', 'docs/', 'anylist-js/', 'node_modules/'],
  textRoots: ['src/', 'scripts/', 'Dockerfile', 'docker-compose', 'compose'],
  replyBound: new Set(),
  // 080: path prefixes where a `pi-guard` tag counts; empty means nowhere (only mcp-host has any).
  piGuards: [],
  // 080 read check: files besides `limits.js` that may read a declaration's own figures, and the
  // names of limits declared and known not to be read yet (this repository declares none: its
  // client is built by the conversion sessions, 080 § AnyList's client).
  tableReaders: [],
  unread: [],
};

// ---- Other files: JavaScript, compose, shell, Dockerfile ----
const NUM = String.raw`-?\d[\d_]*(?:\.\d+)?(?:\s*[*/]\s*\d[\d_]*(?:\.\d+)?)*`;
const JS_PATTERNS = [
  ['const', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*(.*\d.*)$/g],
  ['timer', new RegExp(String.raw`\b(setTimeout|setInterval)\([^;]*,\s*(${NUM})\s*\)`, 'g')],
  ['prop', new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(${NUM})\b`, 'g')],
  ['default', new RegExp(String.raw`[(,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(${NUM})\s*[,)]`, 'g')],
  ['slice', new RegExp(String.raw`\.(?:slice|substring|substr)\(\s*\d+\s*,\s*(${NUM})\s*\)`, 'g')],
  ['length', new RegExp(String.raw`\.length\s*[<>]=?\s*(${NUM})`, 'g')],
  ['lname', new RegExp(
    String.raw`\b(?:const|let|var)\s+([a-z][A-Za-z0-9_]*)\s*=\s*(${NUM})\s*;?\s*$`, 'g')],
  // Not in the Python detector as a pattern (there the AST sees any expression around a literal
  // beside any limit word). Here only a name carrying a STRONG word, or `hours`, `minutes` and
  // `nowSecs` style locals would drown the list: `const deadline = Date.now() + 30000;`.
  ['lexpr', /\b(?:const|let|var)\s+([a-z][A-Za-z0-9_]*)\s*=\s*([^;]*(?<![\w.])\d[^;]*);?\s*$/g],
];
const CONF_PATTERNS = [
  ['key', new RegExp(
    String.raw`^\s*-?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*["']?(${NUM}[a-zA-Z]{0,3})["']?\s*$`,
    'g')],
  ['opt', new RegExp(String.raw`\b(size|nr_inodes|mode)=(${NUM}[kmgKMG]?)`, 'g')],
  ['cmd', new RegExp(
    String.raw`(?<![\w])(sleep|timeout|--max-time|--connect-timeout|--interval|--start-period` +
    String.raw`|--retries|-m|--retry|limit rate|burst)[ =]+(${NUM}[a-z/]*)`, 'g')],
];
const TEXT_SUFFIXES = new Set('.js .mjs .cjs .yml .yaml .service .timer .socket .sh .conf'.split(' '));
const JS_SUFFIXES = new Set(['.js', '.mjs', '.cjs']);
const TRIVIAL_TEXT = new Set(['0', '1', '-1']);

/** Code and comment of a line; a comment marker inside a string does not start one. */
export function splitComment(line, js) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || (js && c === '`')) {
      quote = c;
    } else if ((js && line.startsWith('//', i)) ||
               (!js && c === '#' && (i === 0 || /\s/.test(line[i - 1])))) {
      return [line.slice(0, i), line.slice(i)];
    }
  }
  return [line, ''];
}

/** A number or a product or quotient of numbers, as text (`1024 * 1024`). */
export function evalNum(expr) {
  let total = 1;
  let op = '*';
  for (let part of expr.replaceAll('_', '').split(/([*/])/)) {
    part = part.trim();
    if (part === '*' || part === '/') op = part;
    else if (part) total = op === '*' ? total * Number(part) : total / Number(part);
  }
  return total;
}

function shorten(text) {
  if (text.length <= 160) return text;
  return `${text.slice(0, 80)}...#${createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
}

const hitKey = (h) => [h.path, h.scope, h.what, h.value].join(' | ');
const where = (h) => `${h.path}:${h.line} (${h.scope}) ${h.what} ${h.value}`;

export function textHits(path, text, js) {
  const lines = text.split('\n');
  const tags = new Map();
  const only = new Set();
  const problems = [];
  const split = lines.map((l) => splitComment(l, js));
  split.forEach(([code, comment], i) => {
    const n = i + 1;
    if (comment && !code.trim()) only.add(n);
    if (TAG_WORD.test(comment)) {
      const m = TAG.exec(comment);
      if (m) tags.set(n, { line: n, kind: m.groups.kind, reason: m.groups.reason });
      else problems.push(`${path}:${n}: ${MALFORMED}`);
    }
  });
  const hits = [];
  const used = new Set();
  split.forEach(([code], i) => {
    const n = i + 1;
    const seen = new Set();
    for (const [kind, rx] of js ? JS_PATTERNS : CONF_PATTERNS) {
      for (const m of code.matchAll(rx)) {
        const groups = m.length - 1;
        const name = groups >= 2 ? m[1] : '';
        const val = m[groups].trim();
        if (TRIVIAL_TEXT.has(val) || seen.has(`${name}\0${val}`)) continue;
        if (['prop', 'default', 'lname', 'lexpr', 'key', 'opt'].includes(kind) && !(
          limitish(name) || name === 'size' || name === 'nr_inodes' ||
          (kind === 'key' && name === name.toUpperCase() && /[A-Z]/.test(name) && !js))) continue;
        if (kind === 'lexpr' && (val.includes('=>') || !(val.match(/(?<![\w.])\d+(?:\.\d+)?/g) ?? [])
          .some((x) => Number(x) > 1) || ![...words(name)].some((w) => STRONG.has(w)))) continue;
        if (kind === 'slice' && Math.abs(evalNum(val)) < 16) continue;
        if (kind === 'const' && !/(?<![\w.])\d/.test(val)) continue;
        seen.add(`${name}\0${val}`);
        const tag = tags.get(n) ?? (only.has(n - 1) ? tags.get(n - 1) : undefined);
        if (tag) used.add(tag.line);
        const value = shorten(val.replace(/\s+/g, ''));
        hits.push({ path, line: n, scope: '-', what: `${kind} ${name}`.trim(), value, name, tag });
      }
    }
  });
  for (const n of [...tags.keys()].sort((a, b) => a - b)) {
    if (!used.has(n)) problems.push(`${path}:${n}: ${STRAY}`);
  }
  return { hits, problems };
}

// ---- The files ----
function globToRegex(glob) {
  const body = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

export function skipped(rel, cfg) {
  for (const entry of [...['tests/', 'evals/', ...NON_SHIPPING], ...cfg.skip]) {
    if (entry.endsWith('/')) {
      if (rel.startsWith(entry)) return true;
    } else if (rel === entry || globToRegex(entry).test(rel)) return true;
  }
  return false;
}

function listed(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others',
    '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

export function collect(cfg) {
  const found = { hits: [], problems: [] };
  for (const rel of listed(cfg.root)) {
    const p = join(cfg.root, rel);
    if (skipped(rel, cfg)) continue;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const base = rel.split('/').pop();
    const dot = base.lastIndexOf('.');
    const suffix = dot > 0 ? base.slice(dot).toLowerCase() : '';
    const buf = readFileSync(p);
    const head = suffix ? '' : buf.subarray(0, 200).toString('utf8').split('\n')[0];
    const text = cfg.textRoots.some((r) => rel.startsWith(r)) && (
      TEXT_SUFFIXES.has(suffix) || base.startsWith('Dockerfile') || base.startsWith('Caddyfile') ||
      (head.startsWith('#!') && (head.includes('sh') || head.includes('bash'))));
    if (!text) continue;
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      found.problems.push(`${rel}: is not UTF-8; a file that cannot be read is not skipped`);
      continue;
    }
    const { hits, problems } = textHits(rel, source, JS_SUFFIXES.has(suffix));
    found.hits.push(...hits);
    found.problems.push(...problems);
  }
  return found;
}

// ---- The two lists ----
function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function multiset(items) {
  const m = new Map();
  for (const k of items) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}
/** What `a` holds beyond `b`, as [key, surplus] pairs. */
function surplus(a, b) {
  const out = [];
  for (const [k, n] of [...a].sort()) if (n - (b.get(k) ?? 0) > 0) out.push([k, n - (b.get(k) ?? 0)]);
  return out;
}

function todoLines(cfg) {
  const hits = [];
  const anchors = [];
  for (const line of readLines(join(cfg.guardDir, TODO_NAME))) {
    const parts = line.split(' | ');
    if (parts.length === 4) hits.push(line);
    else {
      const i = line.indexOf(' | ');
      anchors.push([i < 0 ? line : line.slice(0, i), i < 0 ? '' : line.slice(i + 3)]);
    }
  }
  return { hits: multiset(hits), anchors };
}

/** Whether `path`, normalised, sits under a `pi_guards` prefix; matched whole (`walt/` is not
 *  `waltz/`) and after `..` is resolved, so `walt/../pi/x.js` is `pi/x.js`. */
export function onPiGuardPath(path, cfg) {
  const clean = posix.normalize(path);
  return (cfg.piGuards ?? []).some((g) => clean.startsWith(`${posix.normalize(g).replace(/\/$/, '')}/`));
}

function tagProblem(hit, cfg) {
  const tag = hit.tag;
  if (!tag) return null;
  if (!KINDS.includes(tag.kind)) return `the kind \`${tag.kind}\` is not one of ${KINDS.join(', ')}`;
  if (tag.reason.split(/\s+/).filter(Boolean).length < 3) {
    return 'the reason is under three words; say why this is not a limit anyone could change';
  }
  // `maximum` counts only on a name a Limit's maxima take; this repository declares no Limit
  // in JavaScript (Limits live in Q Branch), so there is no such name to find.
  if (tag.kind === 'maximum') {
    return '`maximum` counts only on a name this file passes into a `Limit(...)`\'s maxima';
  }
  if (tag.kind === 'pi-guard' && !onPiGuardPath(hit.path, cfg)) {
    const at = (cfg.piGuards ?? []).map((g) => `\`${g}\``).join(', ') || 'no path in this repository';
    return `\`pi-guard\` counts only under ${at} (Config.piGuards): a cap that protects another ` +
      'machine from a broken-into Pi, so Q Branch, which runs on the Pi, cannot be where it is set';
  }
  if (tag.kind === 'reply-bound' && !cfg.replyBound.has(hit.path)) {
    return '`reply-bound` counts only in a module that reads Q Branch (Config.replyBound)';
  }
  if (tag.kind === 'not-a-limit') {
    const strong = [...words(hit.name)].filter((w) => STRONG.has(w)).sort()[0];
    if (strong) return `\`not-a-limit\` is refused on a name carrying \`${strong}\``;
  }
  return null;
}
const accepted = (hit, cfg) => !!hit.tag && tagProblem(hit, cfg) === null;

export const HOW_OUT = 'Declare it as a Limit (Q Branch\'s Limits page; 059), or, if it is a ' +
  'maximum, a bound on Q Branch\'s own reply, a format fact, a cap that protects another ' +
  'machine from a broken-into Pi (`pi-guard`, only where Config.piGuards allows) or not a limit ' +
  'at all, mark it in ' +
  'place with `// limit-ok: <kind> — <why, three words or more>` and add the same line to ' +
  `${TAGS_NAME}. Adding it to ${TODO_NAME} is not a way out.`;

/** Every hit that is neither accepted by a tag nor on the list: a new limit. */
export function checkNew(cfg) {
  const found = collect(cfg);
  const left = todoLines(cfg).hits;
  const out = [...found.problems];
  for (const hit of found.hits) {
    if (accepted(hit, cfg)) continue;
    const k = hitKey(hit);
    if ((left.get(k) ?? 0) > 0) left.set(k, left.get(k) - 1);
    else out.push(`new limit: ${where(hit)}`);
  }
  return out;
}

/** Every line on the list still matches: a converted value must leave it. */
export function checkList(cfg) {
  const found = collect(cfg);
  const { hits, anchors } = todoLines(cfg);
  const have = multiset(found.hits.filter((h) => !accepted(h, cfg)).map(hitKey));
  const out = [];
  for (const [key, n] of surplus(hits, have)) {
    out.push(`stale line (x${n}) in ${TODO_NAME}: ${key}. The value is no longer a hit ` +
      '(converted, tagged or moved): delete the line.');
  }
  for (const [path, anchor] of anchors) {
    const p = join(cfg.root, path);
    if (!existsSync(p) || !readFileSync(p, 'utf8').includes(anchor)) {
      out.push(`stale anchor in ${TODO_NAME}: ${path} | ${anchor}. The text is gone from the ` +
        'file (converted?): delete the line.');
    }
  }
  for (const line of readLines(join(cfg.guardDir, TODO_NAME))) {
    if (NON_SHIPPING.some((p) => line.startsWith(p))) {
      out.push(`${TODO_NAME}: \`${line.slice(0, 60)}\` names a path that never ships`);
    }
  }
  return out;
}

/** Every tag is valid and on the registry, and the registry holds nothing else. */
export function checkTags(cfg) {
  const found = collect(cfg);
  const out = [...found.problems];
  const have = [];
  for (const hit of found.hits) {
    if (!hit.tag) continue;
    const problem = tagProblem(hit, cfg);
    if (problem) out.push(`${where(hit)}: the \`${hit.tag.kind}\` tag does not count: ${problem}.`);
    else have.push(`${hitKey(hit)} | ${hit.tag.kind} | ${hit.tag.reason}`);
  }
  const registry = multiset(readLines(join(cfg.guardDir, TAGS_NAME)));
  const haveSet = multiset(have);
  for (const [key, n] of surplus(haveSet, registry)) {
    out.push(`tag not in ${TAGS_NAME} (x${n}): ${key}. Add this line.`);
  }
  for (const [key, n] of surplus(registry, haveSet)) {
    out.push(`${TAGS_NAME} line with no matching tag (x${n}): ${key}. Delete it, or fix the ` +
      'tag so its kind and reason are the line\'s.');
  }
  for (const line of readLines(join(cfg.guardDir, TAGS_NAME))) {
    if (NON_SHIPPING.some((p) => line.startsWith(p))) {
      out.push(`${TAGS_NAME}: \`${line.slice(0, 60)}\` names a path that never ships`);
    }
  }
  return out;
}


// ---- The read check (080 § The guard learns a fifth kind and to check reads) ----
// A line-and-brace port of the canonical detector's read check: every declared limit is read, and
// read where it is used. There is no Limit in this repository's JavaScript today, so it passes by
// finding nothing; it is here so the conversion that adds the client is held to the same rules.
const READ_RX = /\b(?:value|atStart|valueInForce)\(/g;
const DECL_RX = /(?:\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*)?\bnew Limit\(\s*['"`]([a-z0-9_]{1,40})['"`]/g;
const TABLE_RX = /\.(defaults|minima|maxima)\[/g;

/** The code of each line with strings blanked and comments gone, and the brace depth where it starts. */
function shape(text) {
  const out = [];
  const classes = [];  // the brace depth of each enclosing class body, innermost last
  let depth = 0;
  for (const raw of text.split('\n')) {
    const [code] = splitComment(raw, true);
    const blank = code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
    out.push({ raw: code, blank, depth, classBody: classes.length ? classes[classes.length - 1] : -1 });
    if (/\bclass\b[^{]*\{/.test(blank)) classes.push(depth + 1);
    for (const c of blank) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    while (classes.length && classes[classes.length - 1] > depth) classes.pop();
  }
  return out;
}

export function readProblems(cfg) {
  const out = [];
  const declared = [];
  const reads = [];
  const tables = [];
  const truthy = [];
  let allText = '';
  for (const rel of listed(cfg.root)) {
    if (skipped(rel, cfg)) continue;
    const base = rel.split('/').pop();
    if (!/\.(m|c)?js$/.test(base) || !cfg.textRoots.some((r) => rel.startsWith(r))) continue;
    let text;
    try { text = readFileSync(join(cfg.root, rel), 'utf8'); } catch { continue; }
    allText += `${text}\n`;
    const lines = shape(text);
    let inCtor = -1;
    const tainted = new Map();
    const aliases = new Map();  // a name bound to a constant: `declared = CAP`, `this.cap = CAP`
    lines.forEach(({ raw, blank, depth, classBody }, i) => {
      const n = i + 1;
      if (/\bconstructor\s*\(/.test(blank)) inCtor = depth;
      else if (inCtor >= 0 && depth <= inCtor + 1 && i > 0 && /^\s*}/.test(blank)) inCtor = -1;  // the constructor's own closing brace
      for (const m of raw.matchAll(DECL_RX)) {
        const applies = /applies:\s*['"](\w+)['"]/.exec(raw)?.[1] ?? 'live';
        declared.push({ path: rel, line: n, name: m[2], ident: m[1] ?? '', applies });
      }
      for (const m of blank.matchAll(/(?:\bthis\.)?\b(\w+)\s*=\s*(?:\w+\.)?([A-Z][A-Z0-9_]*)\s*;/g)) {
        aliases.set(m[1], m[2]);  // a read inside a string is blanked, so it is never matched here
      }
      // Matched on the blanked line: a read written inside a string is not a read.
      for (const m of blank.matchAll(READ_RX)) {
        const after = raw.slice(m.index + m[0].length);
        const args = after.slice(0, after.indexOf(')') < 0 ? undefined : after.indexOf(')'));
        const names = [...args.matchAll(/['"`]([a-z0-9_]{1,40})['"`]/g)].map((x) => x[1]);
        // `X` or `X.name` as an argument, never `X.words` or `X.defaults`; `declared.name` and
        // `this.declared.name` through a name bound to a constant in this file.
        const idents = [...args.matchAll(/(?<![\w.])([A-Z][A-Z0-9_]*)(?:\.name)?(?![\w.(])/g)].map((x) => x[1]);
        for (const o of args.matchAll(/(?:this\.)?\b([a-z]\w*)\.name\b/g)) {
          if (aliases.has(o[1])) idents.push(aliases.get(o[1]));
        }
        const generic = [...args.matchAll(/(?:this\.)?\b([a-z]\w*)\.name\b/g)].some((o) => !aliases.has(o[1]));
        const here = depth + [...blank.slice(0, m.index)].reduce(
          (n, c) => n + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
        const before0 = raw.slice(0, m.index);
        const inArrow = /=>[^;]*$/.test(before0);  // a concise arrow body runs when called
        // module level, a default parameter, or a class field (run at construction, as an `__init__`
        // would, but before any method can read a newer answer)
        const atImport = !inArrow && (here === 0 || (classBody >= 0 && here === classBody) ||
          /\bfunction\b[^)]*=\s*[^)]*$/.test(before0));
        reads.push({ path: rel, line: n, atStart: m[0].startsWith('atStart'), names, idents, generic,
          atImport, inCtor: inCtor >= 0, col: m.index });
        const asg = /\b(?:const|let|var)\s+(\w+)\s*=\s*[\w.]*$/.exec(raw.slice(0, m.index));
        if (asg) tainted.set(asg[1], true);
        const before = raw.slice(0, m.index);
        if (/(!\s*|\|\|\s*|&&\s*|\bif\s*\(\s*)[\w.]*$/.test(before) && !/(?:const|let|var)\s+\w+\s*=\s*[\w.]*$/.test(before)) {
          truthy.push({ path: rel, line: n, what: m[0].replace('(', '') });
        } else if (/^[^)]*\)\s*(\|\||&&|\?(?![?.]))/.test(after.slice(after.indexOf(')'))) && after.includes(')')) {
          truthy.push({ path: rel, line: n, what: m[0].replace('(', '') });
        }
      }
      for (const [name] of tainted) {
        if (new RegExp(`(!\\s*${name}\\b|\\b${name}\\s*(?:\\|\\||&&|\\?(?![?.]))|\\bif\\s*\\(\\s*${name}\\s*\\))`).test(blank) &&
            !new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(blank)) {
          truthy.push({ path: rel, line: n, what: name });
        }
      }
      for (const m of blank.matchAll(TABLE_RX)) {
        if (!/(^|\/)limits\.(m|c)?js$/.test(rel) && !(cfg.tableReaders ?? []).includes(rel)) {
          tables.push({ path: rel, line: n, table: m[1] });
        }
      }
    });
  }
  const unread = cfg.unread ?? [];
  const byName = new Map(declared.map((d) => [d.name, d]));
  // A limit is read when its name, or its constant (`X`, `X.name`, or a name bound to it), is an
  // argument of a read call. A constant only listed, passed to some other call, or had its `.words`
  // or `.defaults` read is not read (the Python check's rule, ported).
  for (const d of declared) {
    const literal = reads.some((r) => r.names.includes(d.name));
    const owned = !!d.ident && reads.some((r) => r.idents.includes(d.ident));
    const ok = literal || owned;
    if (unread.includes(d.name)) {
      if (ok) out.push(`${d.path}:${d.line}: the limit \`${d.name}\` is now read; delete it from CONFIG.unread`);
    } else if (!ok) {
      out.push(`${d.path}:${d.line}: the limit \`${d.name}\` is declared and never read: no read ` +
        'call names it (its name, its constant, or a name bound to it)');
    }
  }
  for (const name of unread) {
    if (!byName.has(name)) out.push(`CONFIG.unread names \`${name}\`, which no Limit declares: delete it`);
  }
  for (const r of reads) {
    const named = r.names.filter((n) => byName.has(n));
    if (r.atImport) {
      out.push(`${r.path}:${r.line}: a read of ${named.length ? `the limit \`${named[0]}\`` : 'a limit'} ` +
        'at module level, in a class field or in a default parameter, run once before Q Branch has answered, so it ' +
        'is the default for ever; read it where it is used');
    }
    const own = new Set(named);
    for (const d of declared) if (d.ident && r.idents.includes(d.ident)) own.add(d.name);
    for (const name of own) {
      const kind = byName.get(name)?.applies ?? 'live';
      if (kind === 'restart' && !r.atStart) {
        out.push(`${r.path}:${r.line}: \`${name}\` is \`restart\` but is read with \`value\`: the page would ` +
          'say a change was picked up that the running server did not build with; read it with `atStart`');
      } else if (kind === 'live' && r.atStart) {
        out.push(`${r.path}:${r.line}: \`${name}\` is \`live\` but is read with \`atStart\`, which holds the ` +
          'value it had at start until a restart; read it with `value` where it is used, or declare it `restart`');
      }
    }
    if (r.inCtor && !r.atStart) {
      const live = [...own].filter((n) => (byName.get(n)?.applies ?? 'live') === 'live');
      if (live.length || r.generic) {
        out.push(`${r.path}:${r.line}: \`${live[0] ?? 'a limit'}\` is read in a constructor but is ` +
          '`live`: it is then read once, and a change on the page needs a restart that the page ' +
          'does not say; read it where it is used, or declare it `restart` and read it with `atStart`');
      }
    }
  }
  for (const t of tables) {
    out.push(`${t.path}:${t.line}: \`.${t.table}[...]\` read outside \`limits.js\`: that is the ` +
      'figure the limit was declared with, not the value in force; read it with `value(...)`');
  }
  for (const t of truthy) {
    out.push(`${t.path}:${t.line}: the value of a limit (\`${t.what}\`) used as a condition: a ` +
      'limit of 0 would mean no limit; compare it (`> 0`, `=== undefined`)');
  }
  return out.sort();
}

/** The one line every run ends with. */
export function summaryLine(guardDir) {
  const todo = readLines(join(guardDir, TODO_NAME));
  const misses = todo.filter((l) => l.split(' | ').length !== 4).length;
  const kinds = {};
  for (const l of readLines(join(guardDir, TAGS_NAME))) {
    const parts = l.split(' | ');
    if (parts.length >= 6) kinds[parts[4]] = (kinds[parts[4]] ?? 0) + 1;
  }
  const tags = [...KINDS].sort().map((k) => `${k} ${kinds[k] ?? 0}`).join(', ');
  return `limits not yet converted: ${todo.length} (hits ${todo.length - misses}, ` +
    `hand-found ${misses}); tags: ${tags}`;
}

export function cli(cfg, argv) {
  if (argv.includes('--emit')) {
    const found = collect(cfg);
    for (const hit of found.hits) if (!accepted(hit, cfg)) console.log(hitKey(hit));
    return 0;
  }
  if (argv.includes('--strict')) {
    const lines = readLines(join(cfg.guardDir, TODO_NAME));
    console.log(lines.join('\n'));
    console.log(summaryLine(cfg.guardDir));
    return lines.length ? 1 : 0;
  }
  console.log(summaryLine(cfg.guardDir));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(cli(CONFIG, process.argv.slice(2)));
}
