/**
 * Installed-version changelog: the payload ships a generator-controlled `CHANGELOG.md` (release
 * flow prepends one `## vX.Y.Z (date)` section per version, content-equivalent to that version's
 * GitHub Release notes), and the Hub serves it through `/api/hub-update/changelog`. Fully
 * offline: nothing here touches the network.
 *
 * Contract discipline: the heading format is machine-written by `scripts/lib/release-notes.mjs`,
 * so parsing is strict — a file whose sections cannot be parsed is reported as unavailable
 * (never partially guessed). `from` slicing answers "what happened while I was away":
 * sections strictly newer than `from`, newest first, with an honest `fromMatched` flag when the
 * origin version predates the changelog's earliest entry.
 */
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { compareStrictSemver } from '@helmx/protocol';

/** One version's section: heading version, ISO date, and the markdown body between headings. */
export interface ChangelogSection {
  version: string;
  date: string;
  markdown: string;
}

/** Heading shape written by the release flow: `## vX.Y.Z (YYYY-MM-DD)`. */
const SECTION_PATTERN = /^## v(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Max changelog bytes read into memory (the shipped file is bounded by release history). */
const MAX_CHANGELOG_BYTES = 512 * 1024;

export interface LoadedChangelog {
  available: boolean;
  /** Path that was read (diagnostics; null when unavailable). */
  sourcePath: string | null;
  sections: ChangelogSection[];
}

/**
 * Resolve the changelog file: explicit env (`HELMX_HUB_CHANGELOG`, `false`/`0`/`''` disables —
 * set by the payload `start.mjs` when the payload root carries the file) with a repo-layout
 * probe fallback (`packages/hub/dist` -> repo root) so dev/source hubs show it too.
 */
export function resolveChangelogPath(env: NodeJS.ProcessEnv, hubEntryDir: string): string | null {
  const explicit = env.HELMX_HUB_CHANGELOG;
  if (explicit !== undefined) {
    if (explicit === '' || explicit === 'false' || explicit === '0') return null;
    return path.resolve(explicit);
  }
  const probed = path.join(hubEntryDir, '..', '..', '..', 'CHANGELOG.md');
  return existsSync(probed) ? probed : null;
}

/** Parse the shipped markdown into sections (newest first as written). Zero sections = unparsable. */
export function parseChangelog(text: string): ChangelogSection[] {
  const lines = text.split('\n');
  const sections: ChangelogSection[] = [];
  let current: { version: string; date: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = SECTION_PATTERN.exec(line);
    if (match !== null) {
      if (current !== null) sections.push({ version: current.version, date: current.date, markdown: current.body.join('\n').trim() });
      current = { version: match[1]!, date: match[2]!, body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) sections.push({ version: current.version, date: current.date, markdown: current.body.join('\n').trim() });
  return sections;
}

/** Read + parse; unreadable/unparsable files are reported as unavailable (never half-guessed). */
export async function loadHubChangelog(env: NodeJS.ProcessEnv, hubEntryDir: string): Promise<LoadedChangelog> {
  const sourcePath = resolveChangelogPath(env, hubEntryDir);
  if (sourcePath === null) return { available: false, sourcePath: null, sections: [] };
  let text: string;
  try {
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile() || stat.size > MAX_CHANGELOG_BYTES) {
      return { available: false, sourcePath, sections: [] };
    }
    text = await fsp.readFile(sourcePath, 'utf8');
  } catch {
    return { available: false, sourcePath, sections: [] };
  }
  const sections = parseChangelog(text);
  if (sections.length === 0) return { available: false, sourcePath, sections: [] };
  return { available: true, sourcePath, sections };
}

export interface ChangelogSlice {
  sections: ChangelogSection[];
  /** Whether `from` itself has a section (false = it predates the changelog's earliest entry). */
  fromMatched: boolean;
}

/** Sections strictly newer than `from` (all sections when `from` is absent), newest first. */
export function sliceChangelog(sections: ChangelogSection[], from?: string): ChangelogSlice {
  if (from === undefined || from === '') return { sections, fromMatched: true };
  return {
    sections: sections.filter((section) => compareStrictSemver(section.version, from) > 0),
    fromMatched: sections.some((section) => section.version === from),
  };
}
