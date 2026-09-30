/**
 * How many columns of a terminal a text takes, for a tool that lines up the
 * columns of a table it prints: `.padEnd` counts UTF-16 units, and `已接受`
 * is three of them and six columns.
 *
 * Counted per grapheme cluster, as a terminal draws one: a cluster takes the
 * width of the first character in it that shows, and what follows that
 * character - a combining mark, a variation selector, a joiner and what it
 * joins - adds nothing.
 *
 * - An East Asian Wide or Fullwidth character takes two: Han, kana and
 *   hangul, full-width forms, and most emoji.
 * - So does an emoji sequence, whatever its first character's own width: an
 *   emoji and the presentation selector U+FE0F (`❤` with it, and a keycap),
 *   a modifier base and a skin tone (`☝` with one), and a flag, two
 *   regional indicators.
 * - A cluster of nothing that shows takes none: combining marks, format
 *   characters - the zero-width space and joiners, the byte-order mark, the
 *   bidirectional controls - and control characters. A soft hyphen shows, as
 *   terminals draw one.
 * - Everything else takes one, East Asian Ambiguous included, as a terminal
 *   draws it outside a legacy East Asian mode.
 *
 * The widths are the table below, fixed. Grapheme clusters and general
 * categories are the runtime's, and a runtime knows the characters of its
 * own Unicode version: only a character assigned after the older of two
 * hosts' versions can be counted differently on them.
 */

/**
 * The East Asian Wide and Fullwidth code points of Unicode 16.0.0
 * (EastAsianWidth-16.0.0.txt), the unassigned ones its `@missing` lines
 * make Wide included, as the first and last of each run, in order.
 *
 * 16.0 is the version both supported lines have: Node 22.16.0 reports
 * `process.versions.unicode` 16.0, and Node 24.18.1 17.0, which Node 22 does
 * not ship. A character is counted as the older line knows it; one 17.0
 * added counts one, as it does on a host that cannot name it.
 */
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3,
  0x25fd, 0x25fe, 0x2614, 0x2615, 0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f,
  0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce,
  0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd,
  0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755,
  0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x303e, 0x3041, 0x3096,
  0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247,
  0x3250, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4,
  0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18cff, 0x18d08, 0x1aff0, 0x1aff3,
  0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152,
  0x1b155, 0x1b155, 0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360, 0x1d376,
  0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202,
  0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320,
  0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3,
  0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc,
  0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596,
  0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2,
  0x1f6d5, 0x1f6d7, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb,
  0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c,
  0x1fa80, 0x1fa89, 0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf, 0x1fae9, 0x1faf0, 0x1faf8,
  0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

/** A character that shows: anything but a control, a format character or a mark, and the soft hyphen. */
const SHOWN = /[^\p{Cc}\p{Cf}\p{Mn}\p{Me}]|\u00ad/u;

/**
 * The start of an emoji sequence a terminal draws as one wide picture: an
 * emoji and the presentation selector, a modifier base and its modifier, or
 * two regional indicators, a flag.
 */
const EMOJI_SEQUENCE = /^(?:\p{Emoji}\ufe0f|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Regional_Indicator}{2})/u;

// Made the first time a width is asked for: loading the segmentation rules
// costs milliseconds that a tool which never measures a string - every one
// that copies this module for its line tables - would pay on each start.
let graphemes: Intl.Segmenter | undefined;

/** The columns a text takes in a terminal. */
export function displayWidth(text: string): number {
  // A named locale, so the host's default is never read; clusters are the
  // same in every locale, and they are what a segmenter gives unless told
  // otherwise.
  graphemes ??= new Intl.Segmenter('en');
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += clusterWidth(segment);
  return width;
}

function clusterWidth(cluster: string): number {
  const at = cluster.search(SHOWN);
  if (at < 0) return 0;
  const shown = cluster.slice(at);
  return isWide(shown.codePointAt(0) as number) || EMOJI_SEQUENCE.test(shown) ? 2 : 1;
}

/**
 * Whether a code point is in {@link WIDE}, by bisection over its runs. The
 * search is half-open, as `inRanges`'s is: `high` is one past the last run
 * still in question.
 */
function isWide(point: number): boolean {
  let low = 0;
  let high = WIDE.length / 2;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (point < (WIDE[2 * mid] as number)) high = mid;
    else if (point > (WIDE[2 * mid + 1] as number)) low = mid + 1;
    else return true;
  }
  return false;
}
