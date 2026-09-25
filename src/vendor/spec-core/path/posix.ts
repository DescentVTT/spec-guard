/**
 * POSIX path arithmetic, independent of the host.
 *
 * Every path the spec-* tools compare is a repository-relative POSIX path, on
 * Windows as much as on Linux. A finding, a graph node or a collision witness
 * that spelled a path one way on one machine and another way on the next would
 * make the same repository give two answers. Node's `path` module takes the
 * host's side, so none of this uses it.
 *
 * Two families of function live here, and the difference matters:
 *
 * - Repository paths (`normalise`, `resolveInside`, `isInside`) may not leave
 *   the repository. A `..` that climbs past the root is an answer of its own -
 *   `null` - never a path silently clamped to the root.
 * - General POSIX paths (`normalisePosix`, `joinPosix`) keep leading `..` and a
 *   leading `/`, for callers that resolve against something other than a
 *   repository root.
 */

const ABSOLUTE = /^(?:[/\\]|[A-Za-z]:)/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A host path in POSIX form: every backslash becomes a slash. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Whether a path names a place outright rather than relative to one.
 *
 * Both platforms' spellings, whichever this runs on: one repository is read on
 * a Windows checkout and in Linux CI, so a path is absolute where it was
 * written. `C:docs` counts - it is relative to a drive, not to a root, and
 * prefixing it with a root would name a third place.
 */
export function isAbsolutePath(value: string): boolean {
  return ABSOLUTE.test(value);
}

/**
 * Whether a link destination is a path relative to the file holding it: not
 * empty, not a fragment, not rooted, and not a URL or `mailto:`.
 *
 * A Windows drive path has a one-letter "scheme" and is excluded with the rest,
 * which is right: it is not relative to anything in the repository.
 */
export function isRelativeReference(target: string): boolean {
  if (target === '' || target.startsWith('#') || isAbsolutePath(target)) return false;
  return !SCHEME.test(target);
}

/** The path part of a link destination, and the `?query` or `#fragment` after it. */
export function splitReference(target: string): { readonly path: string; readonly suffix: string } {
  const cut = target.search(/[?#]/);
  return cut < 0 ? { path: target, suffix: '' } : { path: target.slice(0, cut), suffix: target.slice(cut) };
}

/** The non-empty segments of a POSIX path, without `.`. */
export function segments(value: string): string[] {
  return value.split('/').filter((part) => part !== '' && part !== '.');
}

/**
 * A repository path in canonical form - no `.`, no empty segments, no leading
 * or trailing slash, `..` resolved - or `null` when the path climbs out of the
 * repository or is absolute.
 *
 * Backslashes are separators here: a path typed on Windows is the same path.
 */
export function normalise(value: string): string | null {
  const posix = toPosix(value);
  if (isAbsolutePath(posix)) return null;
  return resolveInside('', posix);
}

/**
 * A relative path resolved against a repository directory, or `null` when it
 * climbs out of the repository.
 */
export function resolveInside(directory: string, relative: string): string | null {
  const out = segments(directory);
  for (const part of segments(relative)) {
    if (part !== '..') {
      out.push(part);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  return out.join('/');
}

/** Whether a canonical repository path is the directory itself or lies beneath it. */
export function isInside(path: string, directory: string): boolean {
  return directory === '' || path === directory || path.startsWith(`${directory}/`);
}

/** The directory holding a path, or `''` at the root. */
export function dirname(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash < 0 ? '' : value.slice(0, slash);
}

/** The last segment of a path. */
export function basename(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

/**
 * The extension of the last segment, dot included and lower-cased, or `''`.
 *
 * A leading dot is a hidden name, not an extension: `.github` has none, and
 * `.eslintrc.json` has `.json`.
 */
export function extname(value: string): string {
  const base = basename(value);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * The relative path from a repository directory to a repository path: what a
 * link written in that directory must say to reach it. `.` for the directory
 * itself.
 */
export function relativePath(fromDirectory: string, to: string): string {
  const from = segments(fromDirectory);
  const target = segments(to);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  const up = from.slice(common).map(() => '..');
  const joined = [...up, ...target.slice(common)].join('/');
  return joined === '' ? '.' : joined;
}

/**
 * Removes `.` and `..` segments from a general POSIX path. Leading `..` of a
 * relative path are kept; a `..` above `/` is dropped, as the kernel does.
 */
export function normalisePosix(value: string): string {
  const absolute = value.startsWith('/');
  const out: string[] = [];
  for (const part of segments(value)) {
    if (part !== '..') {
      out.push(part);
      continue;
    }
    if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else if (!absolute) out.push('..');
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/** Joins general POSIX paths and normalises the result. */
export function joinPosix(...parts: readonly string[]): string {
  return normalisePosix(parts.filter((part) => part.length > 0).join('/'));
}
