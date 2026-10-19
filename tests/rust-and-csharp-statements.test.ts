/**
 * A Rust use declaration and a C# using directive are read as their
 * compilers read them.
 *
 * On 0.26.0 a Rust declaration was the text between `use` and its `;`, cut
 * at braces, commas and ` as `: `use a :: b;` was a module named `a :: b`,
 * blanks and all, and `use r#mod::d;` one named `r#mod::d`. A C# directive
 * was read by a cursor that took no blank and no comment inside a name, no
 * `@` and no escape: `using System . Text;`, `using T = System . Text . Json;`
 * and `using @System.IO;` were each read as nothing. And text that is no
 * declaration, `let r#use = 1;`, a `#region` line, `static object @using =
 * A.B;`, was read as one.
 *
 * The tables are the compilers' own answers. On 2026-10-18 each Rust source
 * was compiled by rustc 1.97.1 (edition 2021) and each C# source by the
 * compiler of the .NET SDK 10.0.401 (`-langversion:latest`), beside the
 * modules and namespaces its names resolve to, and with code that compiles
 * only if each import binds what it is said to. What is asserted is every
 * import by its canonical name and the line spec-guard reports it on, or
 * that the compiler refused the source (ADR-0008, amended 2026-10-18).
 *
 * And what the compiler refuses is said where it starts as a declaration,
 * as a Python statement Python refuses is: one note, of the kind
 * `refused`. On 2026-10-19 each source was given to rustc 1.97.1 in the
 * 2015, 2018, 2021 and 2024 editions, and to the C# compiler as a library
 * and as a program; a note is made only of what each refuses in every one
 * (ADR-0008, amended 2026-10-19).
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import { expandUsePath, MAX_EXPANSION } from '../src/polyglot.js';
import { runSpecGuard } from '../src/runner.js';
import { memoryIo } from './helpers.js';

/** Each import of a source, with the line it is reported on. */
function read(source: string, file: string): Array<[string, number]> {
  return analyzeSource(source, file).references.map((reference) => [reference.specifier, reference.line]);
}
const rust = (source: string): Array<[string, number]> => read(source, 'src/lib.rs');
const csharp = (source: string): Array<[string, number]> => read(source, 'src/Shop.cs');

/** Rust's white space, Unicode's Pattern_White_Space. */
const RUST_SPACES = ['\t', '\n', '\v', '\f', '\r', ' ', '\u{85}', '\u{200e}', '\u{200f}', '\u{2028}', '\u{2029}'];
/** C#'s white space beside a line's end. */
const CSHARP_BLANKS = [' ', '\t', '\v', '\f', '\u{a0}', '\u{3000}'];
/** What ends a line in C#. */
const CSHARP_BREAKS = ['\n', '\r', '\r\n', '\u{85}', '\u{2028}', '\u{2029}'];

/** What rustc 1.97.1 reads of each source: every import, by its canonical name, and its line. */
const RUST_READ: Array<[source: string, imports: Array<[string, number]>]> = [
  ['use a::b;', [['a::b', 1]]], // r-plain
  ['use a :: b;', [['a::b', 1]]], // r-space-both
  ['use a ::b;', [['a::b', 1]]], // r-space-before
  ['use a:: b;', [['a::b', 1]]], // r-space-after
  ['use a\n::\nb;', [['a::b', 1]]], // r-newlines
  ['use a\r\n::\r\nb;', [['a::b', 1]]], // r-crlf
  ['use\ta\t::\tb\t;', [['a::b', 1]]], // r-tabs
  ['use a/* c */::/* d */b;', [['a::b', 1]]], // r-block-comments
  ['use a // c\n::b;', [['a::b', 1]]], // r-line-comment
  ['use/* c */a::b;', [['a::b', 1]]], // r-comment-after-use
  ['use a::b /* c */;', [['a::b', 1]]], // r-comment-before-semicolon
  ['use a::/* x /* y */ z */b;', [['a::b', 1]]], // r-nested-comment
  ['use\u{b}a\u{c}::\u{b}b;', [['a::b', 1]]], // r-vt-ff
  ['use\u{85}a::\u{85}b;', [['a::b', 1]]], // r-nel
  ['use a\u{200e}::\u{200f}b;', [['a::b', 1]]], // r-lrm-rlm
  ['use a::\u{2028}b;', [['a::b', 1]]], // r-line-separator
  ['use\u{2029}a::b;', [['a::b', 1]]], // r-paragraph-separator
  ['use a::b::c;', [['a::b::c', 1]]], // r-deep
  ['use ::core::mem;', [['core::mem', 1]]], // r-leading-separator
  ['use :: core :: mem;', [['core::mem', 1]]], // r-leading-separator-spaced
  ['use r#mod::d;', [['mod::d', 1]]], // r-raw-keyword
  ['use r#a::b;', [['a::b', 1]]], // r-raw-plain
  ['use a::r#b;', [['a::b', 1]]], // r-raw-last
  ['use r#a::r#b as r#x;', [['a::b', 1]]], // r-raw-alias
  ['use r#mod :: d;', [['mod::d', 1]]], // r-raw-spaced
  ['use crate::{r#mod::d};', [['crate::mod::d', 1]]], // r-raw-in-group
  ['use a::b as x;', [['a::b', 1]]], // r-alias
  ['use a::b as _;', [['a::b', 1]]], // r-alias-underscore
  ['use a::b   as   x  ;', [['a::b', 1]]], // r-alias-spaced
  ['use a::b as/* c */x;', [['a::b', 1]]], // r-alias-comment
  ['use a::b\nas\nx;', [['a::b', 1]]], // r-alias-newline
  ['use a::{b, c::d};', [['a::b', 1], ['a::c::d', 1]]], // r-group
  ['use a :: { b , c :: d } ;', [['a::b', 1], ['a::c::d', 1]]], // r-group-spaced
  ['use a::{/* x */b/* y */,/* z */c};', [['a::b', 1], ['a::c', 1]]], // r-group-comments
  ['use a::{b, c::{d, self}};', [['a::b', 1], ['a::c::d', 1], ['a::c', 1]]], // r-group-nested-self
  ['use a::c::{self, d};', [['a::c', 1], ['a::c::d', 1]]], // r-group-self
  ['use a::{self as y};', [['a', 1]]], // r-group-self-alias
  ['use {a::b, a::c};', [['a::b', 1], ['a::c', 1]]], // r-group-no-prefix
  ['use a::{b,};', [['a::b', 1]]], // r-group-trailing-comma
  ['use a::{};', [['a', 1]]], // r-group-empty
  ['use a::{{b}, c};', [['a::b', 1], ['a::c', 1]]], // r-group-in-group
  ['use ::{core::mem};', [['core::mem', 1]]], // r-group-separator-only
  ['use a::{b::{c}, c::{d}};', [['a::b::c', 1], ['a::c::d', 1]]], // r-group-two-deep
  ['use a::{\n    b,\n    c,\n};', [['a::b', 1], ['a::c', 1]]], // r-group-lines
  ['use a::{b::*, c};', [['a::b::*', 1], ['a::c', 1]]], // r-group-glob
  ['use a::{b as x, c as _};', [['a::b', 1], ['a::c', 1]]], // r-group-alias-mix
  ['use a::b::*;', [['a::b::*', 1]]], // r-glob
  ['use a :: b :: * ;', [['a::b::*', 1]]], // r-glob-spaced
  ['use a::b::{*};', [['a::b::*', 1]]], // r-glob-in-braces
  ['use self::a::b;', [['self::a::b', 1]]], // r-self-first
  ['use crate::a::b;', [['crate::a::b', 1]]], // r-crate
  ['use crate :: a :: b;', [['crate::a::b', 1]]], // r-crate-spaced
  ['use a::b::self;', [['a::b', 1]]], // r-self-last
  ['use a::b::self as y;', [['a::b', 1]]], // r-self-last-alias
  ['use crate::a::{self as z};', [['crate::a', 1]]], // r-crate-group-self
  ['use self as this;', [['self', 1]]], // r-self-alone-as
  ['use a::{b, *};', [['a::b', 1], ['a::*', 1]]], // r-glob-bare-in-group
  ['pub use a::b;', [['a::b', 1]]], // r-pub
  ['pub(crate) use a::b;', [['a::b', 1]]], // r-pub-crate
  ['pub(in crate) use a::b;', [['a::b', 1]]], // r-pub-in
  ['#[allow(unused)] use a::b;', [['a::b', 1]]], // r-attribute
  ['pub\nuse a::b;', [['a::b', 2]]], // r-pub-own-line
  ['fn inner() { use a::b; b::at_a_b(); }', [['a::b', 1]]], // r-in-fn
  ['const _: () = { use a::b; };', [['a::b', 1]]], // r-in-block
  ['use a::b; use a::c;', [['a::b', 1], ['a::c', 1]]], // r-two-on-a-line
  ['fn other() {}\nuse a::b;', [['a::b', 2]]], // r-second-line
  ['extern crate core;', [['core', 1]]], // r-extern
  ['extern crate core as k;', [['core', 1]]], // r-extern-alias
  ['extern crate alloc as _;', [['alloc', 1]]], // r-extern-underscore
  ['extern crate self as me;', [['self', 1]]], // r-extern-self
  ['extern /* c */ crate core;', [['core', 1]]], // r-extern-comment
  ['extern\ncrate\ncore\n;', [['core', 1]]], // r-extern-lines
  ['pub extern crate core;', [['core', 1]]], // r-pub-extern
  ['extern crate r#core;', [['core', 1]]], // r-extern-raw
  ['fn f<\'a>(x: &\'a u8) -> impl Sized + use<\'a> { use a::b; b::at_a_b(); x }', [['a::b', 1]]], // r-precise-capturing-then-use
  ['use a::caf\u{e9};', [['a::caf\u{e9}', 1]]], // r-nfc
  ['use a::cafe\u{301};', [['a::caf\u{e9}', 1]]], // r-nfd
  ['use a::\u{6771}\u{4eac};', [['a::\u{6771}\u{4eac}', 1]]], // r-cjk
];

/** Sources rustc compiles that hold no import. */
const RUST_NO_IMPORT: string[] = [
  'fn f() { let r#use = 1; let x = r#use; }', // r-raw-use-identifier
  'static r#use: () = ();', // r-raw-use-assigned
  'fn f<\'a>(x: &\'a u8) -> impl Sized + use<\'a> { x }', // r-precise-capturing
  'const S: &str = "use a::b;";', // r-use-in-string
  'const S: &str = r#"use a::b;"#;', // r-use-in-raw-string
  'struct K { r#use: u8 }', // r-use-as-field
  'mod r#use { pub const LIMIT: u8 = 1; }\nfn f() -> u8 { let x = r#use::LIMIT; x }', // r-raw-use-path
  'mod because { pub const WHY: u8 = 1; }\nfn f() -> u8 { let x = because::WHY; x }', // r-use-inside-a-word
  'mod user { pub const ID: u8 = 1; }\nfn f() -> u8 { let x = user::ID; x }', // r-use-at-the-head-of-a-word
];

/** Sources rustc refuses, with the first thing it said. */
const RUST_REFUSED: string[] = [
  'use a::\u{a0}b;', // r-nbsp-refused: unknown start of token: \u{a0}
  'use a::\u{2003}b;', // r-em-space-refused: unknown start of token: \u{2003}
  'use a: :b;', // r-colon-space-colon-refused: expected `::`, found `:`
  'use a:::b;', // r-three-colons-refused: path separator must be a double colon
  'use a::::b;', // r-four-colons-refused: expected identifier, found `::`
  'use a::;', // r-trailing-separator-refused: expected identifier, found `;`
  'use a b;', // r-two-names-refused: expected one of `::`, `;`, or `as`, found `b`
  'use a::b c;', // r-path-then-name-refused: expected one of `::`, `;`, or `as`, found `c`
  'use a::b\nfn x() {}', // r-no-semicolon-refused: expected `;`, found keyword `fn`
  'use ;', // r-empty-refused: expected identifier, found `;`
  'use 1;', // r-number-refused: expected identifier, found `1`
  'use a.b;', // r-dot-refused: expected one of `::`, `;`, or `as`, found `.`
  'use ::::core::mem;', // r-leading-separator-twice-refused: expected identifier, found `::`
  'use r #mod::d;', // r-raw-space-before-hash-refused: expected one of `::`, `;`, or `as`, found `#`
  'use r# mod::d;', // r-raw-space-after-hash-refused: found invalid character; only `#` is allowed in raw string delimitation:  
  'use r#crate::a;', // r-raw-crate-refused: `crate` cannot be a raw identifier
  'use r#self::a;', // r-raw-self-refused: `self` cannot be a raw identifier
  'use r#super::a;', // r-raw-super-refused: `super` cannot be a raw identifier
  'use r#Self::a;', // r-raw-big-self-refused: `Self` cannot be a raw identifier
  'use r#_::a;', // r-raw-underscore-refused: `_` cannot be a raw identifier
  'use a::b as;', // r-alias-missing-refused: expected identifier, found `;`
  'use a::b as x as y;', // r-alias-twice-refused: expected `;`, found keyword `as`
  'use a::b as 1;', // r-alias-number-refused: expected identifier, found `1`
  'use a::b as x::y;', // r-alias-path-refused: expected `;`, found `::`
  'use a::bas x;', // r-alias-glued-refused: expected one of `::`, `;`, or `as`, found `x`
  'use a::{b, , c};', // r-group-empty-clause-refused: expected identifier, found `,`
  'use a::{b c};', // r-group-two-names-refused: expected one of `,`, `::`, `as`, or `}`, found `c`
  'use a::{b}::c;', // r-group-then-path-refused: expected `;`, found `::`
  'use a::{b;\nfn x() {}', // r-group-unclosed-refused: this file contains an unclosed delimiter
  'use a{b};', // r-group-glued-refused: expected one of `::`, `;`, or `as`, found `{`
  'use a::{, b};', // r-group-leading-comma-refused: expected identifier, found `,`
  'use a::{b,,};', // r-group-two-commas-refused: expected identifier, found `,`
  'use *;', // r-glob-bare-refused: cannot glob-import all possible crates
  'use a::*::b;', // r-glob-middle-refused: expected `;`, found `::`
  'use a::b*;', // r-glob-glued-refused: expected one of `::`, `;`, or `as`, found `*`
  'use a::* as x;', // r-glob-alias-refused: expected `;`, found keyword `as`
  'use a::_;', // r-underscore-segment-refused: expected identifier, found reserved identifier `_`
  'use _::a;', // r-underscore-path-refused: expected identifier, found reserved identifier `_`
  'use a::{_};', // r-alias-underscore-group-refused: expected identifier, found reserved identifier `_`
  'extern crate core::mem;', // r-extern-path-refused: expected one of `;` or `as`, found `::`
  'extern crate "core";', // r-extern-string-refused: expected identifier, found `"core"`
  'extern crate {core};', // r-extern-group-refused: expected identifier, found `{`
];

/** What the C# compiler of the .NET SDK 10.0.401 reads of each source. */
const CSHARP_READ: Array<[source: string, imports: Array<[string, number]>]> = [
  ['using N1.N2;', [['N1.N2', 1]]], // c-plain
  ['\u{feff}using N1.N2;', [['N1.N2', 1]]], // c-byte-order-mark
  ['using N1 . N2;', [['N1.N2', 1]]], // c-space-both
  ['using N1 .N2;', [['N1.N2', 1]]], // c-space-before
  ['using N1. N2;', [['N1.N2', 1]]], // c-space-after
  ['using\nN1\n.\nN2\n;', [['N1.N2', 1]]], // c-newlines
  ['using N1\r\n.N2\r\n;', [['N1.N2', 1]]], // c-crlf
  ['using\tN1\t.\tN2\t;', [['N1.N2', 1]]], // c-tabs
  ['using N1/* c */./* d */N2;', [['N1.N2', 1]]], // c-block-comments
  ['using N1 // c\n.N2;', [['N1.N2', 1]]], // c-line-comment
  ['using/* c */N1.N2;', [['N1.N2', 1]]], // c-comment-after-using
  ['using N1.N2/* c */;', [['N1.N2', 1]]], // c-comment-before-semicolon
  ['using N1./** c */N2;', [['N1.N2', 1]]], // c-doc-comment-between
  ['using\u{b}N1\u{c}.N2;', [['N1.N2', 1]]], // c-vt-ff
  ['using\u{a0}N1\u{a0}.\u{a0}N2;', [['N1.N2', 1]]], // c-nbsp
  ['using N1\u{2003}.N2;', [['N1.N2', 1]]], // c-em-space
  ['using\u{3000}N1.N2;', [['N1.N2', 1]]], // c-ideographic-space
  ['using N1\u{85}.N2;', [['N1.N2', 1]]], // c-nel
  ['using N1.\u{2028}N2;', [['N1.N2', 1]]], // c-line-separator
  ['using\u{2029}N1.N2;', [['N1.N2', 1]]], // c-paragraph-separator
  ['using N1.N2.N3;', [['N1.N2.N3', 1]]], // c-deep
  ['using @N1.N2;', [['N1.N2', 1]]], // c-verbatim-first
  ['using N1.@N2;', [['N1.N2', 1]]], // c-verbatim-last
  ['using @N1.@N2.@N3;', [['N1.N2.N3', 1]]], // c-verbatim-each
  ['using @class.N;', [['class.N', 1]]], // c-verbatim-keyword
  ['using @N1 . @N2;', [['N1.N2', 1]]], // c-verbatim-spaced
  ['using T = @N1.N2;', [['N1.N2', 1]]], // c-verbatim-alias-target
  ['using @T = N1.N2;', [['N1.N2', 1]]], // c-verbatim-alias-name
  ['using static @N1.N2.S;', [['N1.N2.S', 1]]], // c-verbatim-static
  ['using N\\u0031.N2;', [['N1.N2', 1]]], // c-escape-digit
  ['using \\u004E1.N2;', [['N1.N2', 1]]], // c-escape-first
  ['using N1.N\\U00000032;', [['N1.N2', 1]]], // c-escape-long
  ['using C\\u0061f\\u00e9;', [['Caf\u{e9}', 1]]], // c-escape-beyond-ascii
  ['using @\\u004E1.N2;', [['N1.N2', 1]]], // c-escape-verbatim
  ['using Caf\u{e9};', [['Caf\u{e9}', 1]]], // c-nfc
  ['using \u{6771}\u{4eac};', [['\u{6771}\u{4eac}', 1]]], // c-cjk
  ['using N1\u{200b}.N2;', [['N1.N2', 1]]], // c-formatting-character
  ['using N\u{ad}1.N2;', [['N1.N2', 1]]], // c-soft-hyphen
  ['using N\u{ad}\u{200b}1.N2;', [['N1.N2', 1]]], // c-two-formatting-characters
  ['using T = G.L<int?>;', [['G.L', 1]]], // c-alias-generic-nullable
  ['using T = G.L<int[]>;', [['G.L', 1]]], // c-alias-generic-array
  ['using T = G.L<int[,]>;', [['G.L', 1]]], // c-alias-generic-array-ranks
  ['using T = G.L<(int, int)>;', [['G.L', 1]]], // c-alias-generic-tuple
  ['using T = G.L<global::N1.At_N1>;', [['G.L', 1]]], // c-alias-generic-qualified
  ['using static N1.N2.S;', [['N1.N2.S', 1]]], // c-static
  ['using static  N1 . N2 . S;', [['N1.N2.S', 1]]], // c-static-spaced
  ['using/* c */static/* d */N1.N2.S;', [['N1.N2.S', 1]]], // c-static-comment
  ['using static unsafe N1.N2.S;', [['N1.N2.S', 1]]], // c-static-unsafe
  ['using static G.L<int>;', [['G.L', 1]]], // c-static-generic
  ['using static G . L < int >;', [['G.L', 1]]], // c-static-generic-spaced
  ['using static G.L<N1.At_N1>;', [['G.L', 1]]], // c-static-generic-of-a-type
  ['using static global::N1.N2.S;', [['N1.N2.S', 1]]], // c-static-global
  ['using staticN1.N2;', [['staticN1.N2', 1]]], // c-static-glued
  ['using static G.L<int>.Nested;', [['G.L.Nested', 1]]], // c-static-generic-then-name
  ['global using N1.N2;', [['N1.N2', 1]]], // c-global
  ['global  using  N1 . N2;', [['N1.N2', 1]]], // c-global-spaced
  ['global using global::N1.N2;', [['N1.N2', 1]]], // c-global-qualified
  ['global using static N1.N2.S;', [['N1.N2.S', 1]]], // c-global-static
  ['global using T = N1.N2;', [['N1.N2', 1]]], // c-global-alias
  ['global/* c */using N1.N2;', [['N1.N2', 1]]], // c-global-comment
  ['global\nusing N1.N2;', [['N1.N2', 2]]], // c-global-own-line
  ['using global::N1.N2;', [['N1.N2', 1]]], // c-qualified
  ['using global :: N1 . N2;', [['N1.N2', 1]]], // c-qualified-spaced
  ['using global/* c */::/* d */N1.N2;', [['N1.N2', 1]]], // c-qualified-comment
  ['using T = N1.N2;', [['N1.N2', 1]]], // c-alias
  ['using T=N1.N2;', [['N1.N2', 1]]], // c-alias-tight
  ['using T = N1 . N2 ;', [['N1.N2', 1]]], // c-alias-spaced
  ['using T\n=\nN1\n.\nN2\n;', [['N1.N2', 1]]], // c-alias-lines
  ['using T/* c */=/* d */N1.N2;', [['N1.N2', 1]]], // c-alias-comments
  ['using T = global::N1.N2;', [['N1.N2', 1]]], // c-alias-qualified
  ['using T = G.L<int>;', [['G.L', 1]]], // c-alias-generic
  ['using T = G.L<G.L<int>>;', [['G.L', 1]]], // c-alias-generic-nested
  ['using T = G.L<\nint\n>;', [['G.L', 1]]], // c-alias-generic-lines
  ['using T = G . L < int > ;', [['G.L', 1]]], // c-alias-generic-spaced
  ['using unsafe T = N1.N2.V*;', [['N1.N2.V', 1]]], // c-alias-unsafe
  ['using unsafe T = N1.N2;', [['N1.N2', 1]]], // c-alias-unsafe-namespace
  ['using T = N1.N2.At_N1_N2[];', [['N1.N2.At_N1_N2', 1]]], // c-alias-array
  ['using T = N1.N2.At_N1_N2[ , ][];', [['N1.N2.At_N1_N2', 1]]], // c-alias-array-ranks
  ['using T = N1.N2.V?;', [['N1.N2.V', 1]]], // c-alias-nullable-value
  ['namespace N1 . Q { using N2; class P2 { At_N1_N2 a; } }', [['N2', 1]]], // c-namespace-spaced
  ['namespace N1 . Q;\nusing N2;\nclass P2 { At_N1_N2 a; }', [['N2', 2]]], // c-namespace-file-scoped-spaced
  ['namespace @N1.Q { using N2; class P2 { At_N1_N2 a; } }', [['N2', 1]]], // c-namespace-verbatim
  ['namespace N1/* c */.Q { using N2; class P2 { At_N1_N2 a; } }', [['N2', 1]]], // c-namespace-comment
];

/** Sources it compiles that hold no using directive. */
const CSHARP_NO_IMPORT: string[] = [
  'class K { void M() { using (var d = new N1.D()) { } } }', // c-using-statement
  'class K { void M() { using var d = new N1.D(); } }', // c-using-declaration
  'class K { void M() { using N1.D d = new N1.D(); } }', // c-using-declaration-typed
  'class K { void M() { using N1 . D d = new N1.D(); } }', // c-using-declaration-typed-spaced
  'class K { void M() { using (N1.D d = new N1.D()) { } } }', // c-using-statement-typed
  'class K { static object @using = N1.N2.S.F; }', // c-verbatim-using-identifier
  'class K { int @using; void M() { @using = 1; } }', // c-verbatim-using-field
  'class @using { }\nclass K { @using field; }', // c-verbatim-using-type
  'class K { static object usings = N1.N2.S.F; }', // c-using-at-the-head-of-a-word
  '#region using N1.N2;\n#endregion', // c-region
  '#pragma warning disable CS0105 // using N1.N2;', // c-pragma
  'class K { string s = "using N1.N2;"; }', // c-using-in-string
];

/** Sources it refuses, with the first thing it said. */
const CSHARP_REFUSED: string[] = [
  'using N1..N2;', // c-two-dots-refused: error CS1001: Identifier expected
  'using N1.;', // c-trailing-dot-refused: error CS1001: Identifier expected
  'using .N1;', // c-leading-dot-refused: error CS1001: Identifier expected
  'using N1 N2;', // c-two-names-refused: error CS8805: Program using top-level statements must be an executable.
  'using N1.N2\nclass X {}', // c-no-semicolon-refused: error CS1002: ; expected
  'using ;', // c-empty-refused: error CS1001: Identifier expected
  'using N1.N2::N3;', // c-double-colon-later-refused: error CS7000: Unexpected use of an aliased name
  'using @ N1.N2;', // c-verbatim-space-after-at-refused: error CS1001: Identifier expected
  'using @@N1.N2;', // c-verbatim-twice-refused: error CS9008: Sequence of '@' characters is not allowed. A verbatim string or id
  'using \\u0073tatic N1.N2.S;', // c-escape-in-keyword-static-refused: error CS1003: Syntax error, ',' expected
  'using N1\\u002EN2;', // c-escape-dot-refused: error CS1002: ; expected
  '\\u0075sing N1.N2;', // c-escape-in-using-refused: error CS1003: Syntax error, ',' expected
  'using N\\u031.N2;', // c-escape-short-refused: error CS1009: Unrecognized escape sequence
  'using ::N1;', // c-leading-qualifier-refused: error CS1001: Identifier expected
  'using unsafe T = G.L<int*>;', // c-alias-generic-pointer-refused: error CS0306: The type 'int*' may not be used as a type argument
  'using static;', // c-static-missing-refused: error CS1001: Identifier expected
  'using static static N1.N2.S;', // c-static-twice-refused: error CS1041: Identifier expected; 'static' is a keyword
  'using unsafe static N1.N2.S;', // c-unsafe-before-static-refused: error CS9133: 'static' modifier must precede 'unsafe' modifier.
  'using static T = N1.N2.S;', // c-static-alias-refused: error CS8085: A 'using static' directive cannot be used to declare an alias
  'using unsafe N1.N2;', // c-unsafe-namespace-refused: error CS9131: Only a 'using static' or 'using alias' can be 'unsafe'.
  'using unsafe N1;', // c-unsafe-single-name-refused: error CS9131: Only a 'using static' or 'using alias' can be 'unsafe'.
  'using G.L<int>;', // c-namespace-generic-refused: error CS0138: A 'using namespace' directive can only be applied to namespaces; '
  'using global : : N1.N2;', // c-qualified-split-refused: error CS1002: ; expected
  'using global::;', // c-qualified-nothing-refused: error CS1001: Identifier expected
  'using global::global::N1;', // c-qualified-twice-refused: error CS7000: Unexpected use of an aliased name
  'using T = N1.N2.At_N1_N2[;', // c-alias-array-unclosed-refused: error CS1003: Syntax error, ',' expected
  'using T = N1.N2.At_N1_N2[1];', // c-alias-array-sized-refused: error CS0270: Array size cannot be specified in a variable declaration (try init
  'using T = N1.N2.V? X;', // c-alias-suffix-then-name-refused: error CS1002: ; expected
  'using T = ;', // c-alias-nothing-refused: error CS1031: Type expected
  'using T = N1.N2 N3;', // c-alias-two-names-refused: error CS1002: ; expected
  'using T == N1;', // c-alias-double-equals-refused: error CS1002: ; expected
  'using A.B = N1.N2;', // c-alias-dotted-name-refused: error CS1002: ; expected
  'using T = G.L<int;', // c-alias-generic-unclosed-refused: error CS1003: Syntax error, '>' expected
];

/**
 * Of those, the ones the compiler reads as a statement or as no using at
 * all: `using N1 N2;`, and `using` before a `static` written with an escape,
 * as a using declaration of a local, which top-level statements may hold;
 * and a `using` written with an escape, as a name.
 */
const CSHARP_REFUSED_AS_A_STATEMENT: string[] = CSHARP_REFUSED.filter((source) => /^using N1 N2;$|^using \\u0073tatic|^\\u0075sing/.test(source));

describe('a Rust use declaration', () => {
  it.each(RUST_READ)('%j is read as rustc 1.97.1 reads it', (source, imports) => {
    expect(rust(source)).toEqual(imports);
  });

  it.each(RUST_NO_IMPORT)('%j holds no import, as rustc 1.97.1 reads it', (source) => {
    expect(rust(source)).toEqual([]);
  });

  it.each(RUST_REFUSED)('%j, which rustc 1.97.1 refuses, is read as nothing', (source) => {
    expect(rust(source)).toEqual([]);
  });

  it.each(RUST_SPACES.map((space) => [space]))('reads an extern crate with %j between its two words', (space) => {
    expect(rust(`extern${space}crate core;`)).toEqual([['core', 1]]);
  });

  it('reads no extern crate with a character between its words that is no white space', () => {
    expect(rust('extern\u{a0}crate core;')).toEqual([]);
    expect(rust('externcrate core;')).toEqual([]);
  });

  it.each([
    ['a mark for its name', 'extern crate *;'],
    ['`_` for its name', 'extern crate _;'],
    ['a mark for its alias', 'extern crate core as *;'],
    ['no alias after `as`', 'extern crate core as'],
    ['a raw `as`, which is a name', 'extern crate core r#as k;'],
    ['no semicolon', 'extern crate core'],
  ])('reads nothing of an extern crate with %s, which rustc refuses', (_name, source) => {
    expect(rust(source)).toEqual([]);
  });

  it('reads nothing of a use with a raw `as` where its alias stands, which rustc refuses', () => {
    expect(rust('use a::b r#as x;')).toEqual([]);
    expect(rust('use a::r#as;')).toEqual([['a::as', 1]]);
  });
});

describe('a C# using directive', () => {
  it.each(CSHARP_READ)('%j is read as the C# compiler reads it', (source, imports) => {
    expect(csharp(source)).toEqual(imports);
  });

  it.each(CSHARP_NO_IMPORT)('%j holds no using directive, as the C# compiler reads it', (source) => {
    expect(csharp(source)).toEqual([]);
  });

  it.each(CSHARP_REFUSED)('%j, which the C# compiler refuses, is read as nothing', (source) => {
    expect(csharp(source)).toEqual([]);
  });

  it('reads a using inside a namespace whose name is written with blanks, a comment or an @', () => {
    for (const declared of ['N1 . Q', 'N1/* c */.Q', '@N1.Q', 'N1.\nQ']) {
      const analysis = analyzeSource(`namespace ${declared} { using N2; }`, 'src/Shop.cs');
      expect(analysis.namespaces, declared).toEqual(['N1.Q']);
      expect(analysis.references.map(({ specifier, namespace }) => [specifier, namespace]), declared).toEqual([['N2', 'N1.Q']]);
    }
    const scoped = analyzeSource('namespace N1 . Q;\nusing N2;\n', 'src/Shop.cs');
    expect([scoped.namespaces, scoped.references.map(({ namespace }) => namespace)]).toEqual([['N1.Q'], ['N1.Q']]);
  });

  it('ends no file-scoped namespace at a brace that closes nothing, since it covers the rest of the file', () => {
    const analysis = analyzeSource('namespace Shop;\n}\nusing Db;\n', 'src/Shop.cs');
    expect([analysis.namespaces, analysis.references.map(({ specifier, namespace }) => [specifier, namespace])]).toEqual([['Shop'], [['Db', 'Shop']]]);
  });

  it('declares no namespace whose name C# refuses, and reads the using after it outside any', () => {
    for (const declared of ['N1.', 'N1 Q', '@ N1', 'N1::Q']) {
      const analysis = analyzeSource(`namespace ${declared} { }\nusing N2;\n`, 'src/Shop.cs');
      expect(analysis.namespaces, declared).toEqual([]);
      expect(analysis.references.map(({ specifier, namespace }) => [specifier, namespace]), declared).toEqual([['N2', undefined]]);
    }
  });

  it('reads no directive in a pre-processing line, whatever stands before its #', () => {
    for (const blank of ['', ...CSHARP_BLANKS]) {
      expect(csharp(`${blank}#region using Shop.Db;\n#endregion\nusing Shop.Ui;\n`), JSON.stringify(blank)).toEqual([['Shop.Ui', 3]]);
    }
  });

  it.each(CSHARP_BREAKS.map((ending) => [ending]))('reads the directive after a pre-processing line that %j ends', (ending) => {
    expect(analyzeSource(`#pragma warning disable${ending}using Shop.Ui;`, 'src/Shop.cs').references.map(({ specifier }) => specifier)).toEqual(['Shop.Ui']);
  });

  it('counts no brace of a pre-processing line', () => {
    // 0.26.0 closed the namespace at the brace of the #region line.
    const analysis = analyzeSource('namespace Shop {\n#region }\nusing Db;\n#endregion\n}\nusing Ui;\n', 'src/Shop.cs');
    expect(analysis.references.map(({ specifier, namespace }) => [specifier, namespace])).toEqual([
      ['Db', 'Shop'],
      ['Ui', undefined],
    ]);
  });

  it('reads past a byte order mark at the head of a file, which is no character of its text', () => {
    expect(csharp('\u{feff}using Shop.Db;\n')).toEqual([['Shop.Db', 1]]);
    expect(analyzeSource('\u{feff}// head\nusing Shop.Db;\n', 'src/Shop.cs').references.map(({ line, column }) => [line, column])).toEqual([[2, 1]]);
    expect(analyzeSource('\u{feff}namespace Shop.Db;\n', 'src/Shop.cs').namespaces).toEqual(['Shop.Db']);
    expect(csharp('\u{feff}#region using Shop.Db;\n#endregion\n')).toEqual([]);
    // Anywhere else it is a formatting character, which continues a name.
    expect(csharp('x\u{feff}using Shop.Db;\n')).toEqual([]);
  });

  it('reads no directive at an identifier written @using or @namespace', () => {
    expect(csharp('class K { static object @using = Shop.Db.Pool; }\n')).toEqual([]);
    expect(analyzeSource('var x = @namespace;\n@namespace = Shop.Db;\n', 'src/Shop.cs').namespaces).toEqual([]);
  });

  it('reads nothing of an escape that writes no character, and the directive after it', () => {
    expect(csharp('using Shop\\UFFFFFFFF.Db;\nusing Shop.Ui;\n')).toEqual([['Shop.Ui', 2]]);
    expect(csharp('using Shop\\U00110000.Db;\nusing Shop.Ui;\n')).toEqual([['Shop.Ui', 2]]);
    expect(csharp('using Shop\\U0001D49C;\n')).toEqual([['Shop\u{1d49c}', 1]]);
    expect(csharp('using Shop\\uD800.Db;\nusing Shop.Ui;\n')).toEqual([['Shop.Ui', 2]]);
  });
});

describe('a declaration left open', () => {
  it('is never read on into the next one', () => {
    expect(rust('use a::\nuse c::d;\n')).toEqual([['c::d', 2]]);
    expect(rust('use a::{b\nuse c::d;\n')).toEqual([['c::d', 2]]);
    expect(rust('use a::\nextern crate core;\n')).toEqual([['core', 2]]);
    expect(rust('use a::r#use;\n')).toEqual([['a::use', 1]]);
    expect(csharp('using Shop.\nusing Ui;\n')).toEqual([['Ui', 2]]);
    expect(csharp('using D = G.L<int\nusing Ui;\n')).toEqual([['Ui', 2]]);
    const resumed = analyzeSource('using static G.L<\nnamespace Ui;\nusing Db;\n', 'src/Shop.cs');
    expect([resumed.namespaces, resumed.references.map(({ specifier, line, namespace }) => [specifier, line, namespace])]).toEqual([
      ['Ui'],
      [['Db', 3, 'Ui']],
    ]);
    // The keyword after `as` leaves the first open, and starts the next.
    expect(rust('use a::b as use a::c;\n')).toEqual([['a::c', 1]]);
    expect(rust('use a::b as extern crate core;\n')).toEqual([['core', 1]]);
    const namespace = analyzeSource('namespace Shop.\nusing Ui;\n', 'src/Shop.cs');
    expect([namespace.namespaces, namespace.references.map(({ specifier }) => specifier)]).toEqual([[], ['Ui']]);
  });
});

describe('what is not asked of a declaration', () => {
  it('is the normal form of a C# name, which the compiler compares as written', () => {
    expect(csharp('using Cafe\u{301};')).toEqual([['Cafe\u{301}', 1]]);
    expect(rust('use a::cafe\u{301};')).toEqual([['a::caf\u{e9}', 1]]);
  });

  it('is where a C# directive stands among the members of a namespace or a type, which the compiler refuses', () => {
    expect(csharpSaid('class A {}\nusing N1.N2;')).toEqual([[['N1.N2', 2]], []]);
    expect(csharpSaid('class K { using N1.N2; }')).toEqual([[['N1.N2', 1]], []]);
  });
});

describe('how much a use declaration may name', () => {
  const wide = (paths: number): string => `use a::{${Array.from({ length: paths }, (_, at) => `m${at}`).join(', ')}};`;
  const nested = (depth: number): string => `use ${'a::{'.repeat(depth)}b${'}'.repeat(depth)};`;

  it('is MAX_EXPANSION paths, and one more is reported, with no path read', () => {
    expect(rust(wide(MAX_EXPANSION))).toHaveLength(MAX_EXPANSION);
    const over = analyzeSource(wide(MAX_EXPANSION + 1), 'src/lib.rs');
    expect([over.references, over.notes.map(({ kind, line }) => [kind, line])]).toEqual([[], [['truncated', 1]]]);
  });

  it('is groups MAX_EXPANSION deep, and one deeper is reported, as twenty thousand are', () => {
    expect(rust(nested(MAX_EXPANSION))).toEqual([[`${'a::'.repeat(MAX_EXPANSION)}b`, 1]]);
    for (const depth of [MAX_EXPANSION + 1, 20_000]) {
      const over = analyzeSource(nested(depth), 'src/lib.rs');
      expect([over.references, over.notes.map(({ kind }) => kind)], String(depth)).toEqual([[], ['truncated']]);
    }
  });

  it('reads the declaration after one that was reported', () => {
    expect(rust(`${wide(MAX_EXPANSION + 1)}\nuse c::d;\n`)).toEqual([['c::d', 2]]);
  });
});

describe('expandUsePath', () => {
  it('reads a tree with its semicolon or without, and white space after either', () => {
    for (const space of RUST_SPACES) {
      expect(expandUsePath(`a :: {b, c}${space}`), JSON.stringify(space)).toEqual(['a::b', 'a::c']);
      expect(expandUsePath(`a :: {b, c};${space}`), JSON.stringify(space)).toEqual(['a::b', 'a::c']);
    }
  });

  it('names nothing where text follows the tree, or the tree is none', () => {
    expect(expandUsePath('a::b; c')).toEqual([]);
    expect(expandUsePath('a::b c')).toEqual([]);
    expect(expandUsePath('a::b;;')).toEqual([]);
    expect(expandUsePath('a::b\u{a0}')).toEqual([]);
    expect(expandUsePath('a::')).toEqual([]);
    expect(expandUsePath('a::b as;')).toEqual([]);
    expect(expandUsePath('a::{b as}')).toEqual([]);
    expect(expandUsePath('a::{b,')).toEqual([]);
  });

  it('names no module for a glob of nothing, and the module for a glob of one', () => {
    expect(expandUsePath('*')).toEqual([]);
    expect(expandUsePath('{*, a::*}')).toEqual(['a::*']);
  });
});

describe('an import rule over Rust and C#', () => {
  const root = path.resolve('/virtual');
  const report = (module: string, file: string, source: string) =>
    runSpecGuard({
      root,
      patterns: ['docs/a.md'],
      io: memoryIo(root, {
        'docs/a.md': `<!-- @assert-import-absence target="src" module="${module}" -->\n`,
        [file]: source,
      }),
    });

  it('fails for an import written with blanks, a raw name or an @, as for one written without', async () => {
    const written: Array<[module: string, file: string, source: string]> = [
      ['crate::db', 'src/lib.rs', 'use crate :: db :: Pool;\n'],
      ['crate::db', 'src/lib.rs', 'use crate::{db :: Pool};\n'],
      ['crate::db', 'src/lib.rs', "fn f<'a>(x: &'a u8) -> impl Sized + use<'a> { use crate::db::Pool; x }\n"],
      ['serde', 'src/lib.rs', 'use ::serde::{Deserialize};\n'],
      ['crate::mod', 'src/lib.rs', 'use crate::r#mod::Pool;\n'],
      ['Shop.Db', 'src/Shop.cs', 'using Shop . Db;\n'],
      ['Shop.Db', 'src/Shop.cs', 'using Pool = Shop . Db . Pool;\n'],
      ['Shop.Db', 'src/Shop.cs', 'using @Shop.Db;\n'],
      ['Shop.Db', 'src/Shop.cs', 'using static Shop.Db.Pool<int>;\n'],
    ];
    for (const [module, file, source] of written) {
      const result = await report(module, file, source);
      expect([result.ok, result.results[0]?.actual], source).toEqual([false, 1]);
      expect(result.results[0]?.matches.map(({ line }) => line), source).toEqual([1]);
    }
  });

  it('reports an extern crate by the verb of a use', async () => {
    const result = await report('core', 'src/lib.rs', 'extern crate core as k;\n');
    expect([result.ok, result.results[0]?.matches.map(({ text }) => text)]).toEqual([false, ['use core']]);
  });

  it('holds over a declaration the compiler refuses, and over text that is none', async () => {
    const none: Array<[module: string, file: string, source: string]> = [
      ['crate::db', 'src/lib.rs', 'use crate::db::Pool\n'],
      ['crate::db', 'src/lib.rs', 'use crate :: :: db;\n'],
      ['Shop.Db', 'src/Shop.cs', 'using Shop . ;\n'],
      ['Shop.Db', 'src/Shop.cs', '#region using Shop.Db;\n#endregion\n'],
      ['Shop.Db', 'src/Shop.cs', 'class K { static object @using = Shop.Db.Pool; }\n'],
    ];
    for (const [module, file, source] of none) {
      const result = await report(module, file, source);
      expect([result.ok, result.results[0]?.actual], source).toEqual([true, 0]);
    }
  });
});

/** Each import of a source with its line, and each note with its line. */
function said(source: string, file: string): [Array<[string, number]>, Array<[string, number]>] {
  const analysis = analyzeSource(source, file);
  return [analysis.references.map((reference) => [reference.specifier, reference.line]), analysis.notes.map((note) => [note.kind, note.line])];
}
const rustSaid = (source: string) => said(source, 'src/lib.rs');
const csharpSaid = (source: string) => said(source, 'src/Shop.cs');
const REFUSED: Array<[string, number]> = [['refused', 1]];

describe('a declaration the compiler refuses, where it starts as one', () => {
  // Measured on 2026-10-19: each is refused by rustc 1.97.1 in the 2015,
  // 2018, 2021 and 2024 editions, or by the compiler of the .NET SDK
  // 10.0.401 as a library and as a program (ADR-0008, amended 2026-10-19).
  it.each(RUST_REFUSED.filter((source) => source !== 'use *;'))('%j is read as nothing and said once, on its line', (source) => {
    expect(rustSaid(source)).toEqual([[], REFUSED]);
  });

  it.each(CSHARP_REFUSED.filter((source) => !CSHARP_REFUSED_AS_A_STATEMENT.includes(source)))('%j is read as nothing and said once, on its line', (source) => {
    expect(csharpSaid(source)).toEqual([[], REFUSED]);
  });

  it.each([
    // The ten 0.27.0 read though rustc refuses them, and their kind.
    ['a keyword of every edition for a segment', ['use mod::d;', 'use a::fn;', 'use a::true;', 'use a::macro;', 'use a::yield;', 'use a::Self;', 'use Self::a;']],
    ['a keyword for an alias or a crate', ['use a::b as fn;', 'use a::b as self;', 'extern crate fn;', 'extern crate core as fn;', 'extern crate crate;', 'extern crate super;', 'extern crate Self;']],
    ['a doc comment between two tokens', ['use a::/** c */b;', 'use a::/// c\nb;', 'use a:://! c\nb;', 'use a::/*! c */b;', 'use /** c */ a::b;', 'use a::b /** c */;', 'use a::{/// c\nb};', 'extern crate /** c */ core;']],
    ['`self` neither first nor last', ['use a::self::b;', 'use ::self::a;', 'use a::{self::b};']],
    ['`super` after a segment that is no `super` and no first `self`', ['use a::super::b;', 'use crate::super::a;', 'use a::{super::b};', 'use ::super::a;']],
    ['`crate` after the first segment, or after `::`', ['use a::crate::b;', 'use ::crate::a;', 'use a::{crate::b};']],
    ['a module of its own with no name given with `as`', ['use crate;', 'use self;', 'use super;', 'use {self};', 'use {crate};', 'use crate::self;', 'use crate::{self};', 'use self::{self};', 'use self::super;', 'use super::super;', 'use super::{self};', 'extern crate self;']],
    ['a `$` name, outside a macro', ['use $crate::a;', 'use $crate as x;', 'use $x;']],
    ['a `::` inside a group', ['use a::{::b};']],
  ])('is said where it has %s', (_kind, sources) => {
    for (const source of sources) expect(rustSaid(source), source).toEqual([[], REFUSED]);
  });

  it.each([
    ['a keyword, written plain', ['using class.N;', 'using N1.int;', 'using int;', 'using class = N1.N2;', 'using static int;']],
    ['a type an alias cannot name', ['using T = void;', 'using T = int*;', 'using T = (int);', 'using T = ();', 'using T = G.L<>;', 'using unsafe T = G.L<delegate*<void>>;', 'using unsafe T = (delegate*<void>, int);', 'using static (int, int);']],
  ])('is said where it has %s', (_kind, sources) => {
    for (const source of sources) expect(csharpSaid(source), source).toEqual([[], REFUSED]);
  });

  it('is said where an item or a statement may start, and where a directive may', () => {
    for (const source of ['pub(crate) use a::b c;', 'pub(in crate) use a::{,};', 'pub use a::b c;', '#[allow(unused)] use a::b c;', '#[cfg(any())] use a::b c;']) {
      expect(rustSaid(source), source).toEqual([[], REFUSED]);
    }
    for (const source of ['fn f() { let x = 1; use a::b c; }', 'fn f() { use a::b c; }', '#[cfg(any())] mod m { use a::b c; }']) {
      expect(rustSaid(source), source).toEqual([[], REFUSED]);
    }
    expect(rustSaid('struct S;\nuse a::b c;')).toEqual([[], [['refused', 2]]]);
    expect(rustSaid('mod m {}\nuse a::b c;')).toEqual([[], [['refused', 2]]]);
    expect(rustSaid('use a::b; use a::b c;')).toEqual([[['a::b', 1]], REFUSED]);
    for (const source of ['namespace Q { using N1.; }', 'global using N1.;', 'using N1.N2']) {
      expect(csharpSaid(source), source).toEqual([[], REFUSED]);
    }
    expect(csharpSaid('namespace Q;\nusing N1.;')).toEqual([[], [['refused', 2]]]);
    expect(csharpSaid('extern alias X;\nusing N1.;')).toEqual([[], [['refused', 2]]]);
    expect(csharpSaid('#if NEVER\n#endif\nusing N1.;')).toEqual([[], [['refused', 3]]]);
    expect(csharpSaid('#region r\nusing N1.;\n#endregion')).toEqual([[], [['refused', 2]]]);
  });

  it('is said once, and the declaration after it is read, where a keyword leaves it open', () => {
    expect(rustSaid('use a::b as use a::c;\n')).toEqual([[['a::c', 1]], REFUSED]);
    expect(rustSaid('use a::b as extern crate core;\n')).toEqual([[['core', 1]], REFUSED]);
    expect(rustSaid('use a::\nuse c::d;\n')).toEqual([[['c::d', 2]], REFUSED]);
  });
});

describe('what the compiler compiles, or reads as no declaration, is not said', () => {
  it('where the word is a keyword only from an edition on, which is in Cargo.toml', () => {
    // rustc 1.97.1 compiles each in the 2015 edition, and `gen` up to 2021.
    for (const word of ['async', 'await', 'dyn', 'try', 'gen']) {
      expect(rustSaid(`use kw::${word};`), word).toEqual([[[`kw::${word}`, 1]], []]);
    }
    expect(rustSaid('use kw::plain as async;')).toEqual([[['kw::plain', 1]], []]);
    expect(rustSaid('extern crate core as async;')).toEqual([[['core', 1]], []]);
    // A weak keyword is a name, and a keyword written raw is one too.
    for (const word of ['union', 'macro_rules', 'raw', 'safe']) expect(rustSaid(`use kw::${word};`), word).toEqual([[[`kw::${word}`, 1]], []]);
    expect(rustSaid('use kw::r#fn;')).toEqual([[['kw::fn', 1]], []]);
    expect(rustSaid('use kw::plain as r#fn;')).toEqual([[['kw::plain', 1]], []]);
  });

  it('where a comment between two tokens is no doc comment, or one stands outside the declaration', () => {
    for (const source of ['use a::/*** c */b;', 'use a::/**/b;', 'use a:://// c\nb;', '/** c */ use a::b;', 'use a::b; /// c\nfn f() {}']) {
      expect(rustSaid(source), source).toEqual([[['a::b', 1]], []]);
    }
    expect(rustSaid('/// c\nuse a::b;')).toEqual([[['a::b', 2]], []]);
  });

  it('where self, super and crate stand as rustc takes them', () => {
    const read: Array<[string, string]> = [
      ['use self::a as z;', 'self::a'],
      ['use a::b::self;', 'a::b'],
      ['use self as s;', 'self'],
      ['use crate as c;', 'crate'],
      ['mod m { use super::a; }', 'super::a'],
      ['mod m { mod n { use super::super::a; } }', 'super::super::a'],
      ['mod m { use self::super::a; }', 'self::super::a'],
      ['mod m { use super as s; }', 'super'],
      ['mod m { mod n { use self::super as p; } }', 'self::super'],
      ['mod m { mod n { use super::super as g; } }', 'super::super'],
      ['use {crate::a as z};', 'crate::a'],
      ['use {self::a as z};', 'self::a'],
      ['use a::{self as x};', 'a'],
      ['use crate::{self as root2};', 'crate'],
      ['use {self as this_module};', 'self'],
      ['use self::{self as m3};', 'self'],
      ['use crate::self as r;', 'crate'],
      ['extern crate self as me;', 'self'],
    ];
    for (const [source, name] of read) expect(rustSaid(source), source).toEqual([[[name, 1]], []]);
    // The crate root in the 2015 edition, refused from 2018, which the
    // reader cannot tell apart; and a group that names nothing.
    expect(rustSaid('use ::{self as root};')).toEqual([[['self', 1]], []]);
    expect(rustSaid('use {};')).toEqual([[], []]);
    expect(rustSaid('use ::{};')).toEqual([[], []]);
  });

  it('where `use` is no declaration: a bound, a postfix, a closure', () => {
    // rustc 1.97.1 compiles the bounds, and refuses the other two as
    // ergonomic clones, which are experimental: they start no declaration.
    for (const source of ["fn f<'a>(x: &'a u8) -> impl Sized + use<'a> { x }", "fn f<'a>(x: &'a u8) -> impl use<'a> + Sized { x }", 'fn f() { let x = 1; let _y = x.use; }', 'fn f() { let _c = use || 1; }']) {
      expect(rustSaid(source), source).toEqual([[], []]);
    }
  });

  it("among a macro's tokens, which rustc does not read as a declaration", () => {
    const tokens = 'macro_rules! m { ($($t:tt)*) => {}; }\n';
    for (const source of [`${tokens}m! { use #name::Thing; }`, `${tokens}m!(use a::b c);`, `${tokens}m![use a::{b, , c}];`, `${tokens}crate::m2!(use a::b c);`, 'macro_rules! k { (use $p:path) => {}; }', 'macro_rules! k ( () => { use a::b c; } );', 'macro_rules! k { () => { use crate::fn; }; }', 'macro m($x:ident) { use a::b c; }', 'macro m { () => { use a::b c; } }', '#[my(use a::b c)] fn f() {}', '#![my(use a::b c)]']) {
      expect(rustSaid(source), source).toEqual([[], []]);
    }
    // What is read there is read as it always was.
    expect(rustSaid('macro_rules! k { ($p:path) => { use $p; }; }')).toEqual([[['$p', 1]], []]);
    expect(rustSaid('macro_rules! k { () => { use $crate::a::b; }; }')).toEqual([[['$crate::a::b', 1]], []]);
    // And after one, a declaration is said again.
    expect(rustSaid(`${tokens}m! { use a::b c; }\nuse a::b c;`)).toEqual([[], [['refused', 3]]]);
  });

  it('where the glob of a module the reader cannot place is one rustc takes in the 2015 edition', () => {
    // `use *;` imports the crate root in a module of a 2015 crate, and
    // rustc refuses it at the root and from 2018: nothing is read, as before.
    expect(rustSaid('use *;')).toEqual([[], []]);
  });

  it('where a C# using starts a statement or a declaration, in top-level statements', () => {
    for (const source of ['using var d = new N1.D();', 'using N1.D d = new N1.D();', 'using N1.D? d = null;', 'using (var d = new N1.D()) { }', 'using (new N1.D()) { }', 'await using var a = new N1.AD();', 'await using (var a = new N1.AD()) { }', 'N1.N2.S.M();\nusing var d = new N1.D();', 'if (true) { }\nusing var d = new N1.D();', 'using G.L<int> l = null;']) {
      expect(csharpSaid(source), source).toEqual([[], []]);
    }
    // And those the compiler reads as a declaration, and refuses as one.
    for (const source of CSHARP_REFUSED_AS_A_STATEMENT) expect(csharpSaid(source), source).toEqual([[], []]);
  });

  it('where a C# alias names any type the compiler takes, a tuple, a keyword or a function pointer', () => {
    for (const source of [
      'using T = (int, string);',
      'using T = (int a, string b);',
      'using T = (int, string)[];',
      'using T = (int, string)?;',
      'using T = ((int, int), (string, string));',
      'using T = int;',
      'using T = int[];',
      'using T = string;',
      'using T = int?;',
      'using unsafe T = int*;',
      'using unsafe T = int**;',
      'using unsafe T = void*;',
      'using unsafe T = delegate*<void>;',
      'using unsafe T = delegate*<int, string, void>;',
      'using unsafe T = delegate* unmanaged[Cdecl]<int, void>;',
      'using unsafe T = delegate*<ref int, ref readonly int>;',
      'using unsafe T = delegate*<int*, void>;',
      'using unsafe T = delegate*<void>*;',
      'using unsafe T = delegate*<void>[];',
    ]) {
      expect(csharpSaid(source), source).toEqual([[], []]);
    }
    for (const [source, name] of [
      ['using T = G.L<(int, int)>;', 'G.L'],
      ['using T = G.L<int>;', 'G.L'],
      ['using T = G.L<dynamic>;', 'G.L'],
      ['using T = dynamic;', 'dynamic'],
      ['using T = nint;', 'nint'],
      ['using static G.L<(int, int)>;', 'G.L'],
      ['using unsafe T = G.L<int>*;', 'G.L'],
      ['using \\u0063lass.N;', 'class.N'],
      ['using @class.N;', 'class.N'],
      ['using var;', 'var'],
      ['using global.N;', 'global.N'],
    ]) {
      expect(csharpSaid(source!), source).toEqual([[[name, 1]], []]);
    }
  });

  it('where a C# directive stands in a section an #if may leave out, which the compiler then never reads', () => {
    expect(csharpSaid('#if NEVER\nusing N1.;\n#endif')).toEqual([[], []]);
    expect(csharpSaid('#if NEVER\n#if ALSO\n#endif\nusing N1.;\n#endif')).toEqual([[], []]);
    expect(csharpSaid('#if NEVER\nusing N1.;\n#else\nusing N1.N2;\n#endif')).toEqual([[['N1.N2', 4]], []]);
    // One left open runs to the end of the file.
    expect(csharpSaid('#if NEVER\nusing N1.;\n')).toEqual([[], []]);
  });

  it('where a C# directive stands in a brace that is no namespace', () => {
    expect(csharpSaid('class K { using N1.; }')).toEqual([[], []]);
  });
});

describe('an import rule over a declaration the compiler refuses', () => {
  const root = path.resolve('/virtual');
  const report = (file: string, source: string, strictTargets: boolean) =>
    runSpecGuard({
      root,
      patterns: ['docs/a.md'],
      strictTargets,
      io: memoryIo(root, {
        'docs/a.md': '<!-- @assert-import-absence target="src" module="forbidden" -->\n',
        [file]: source,
      }),
    });
  const RUST_NOTE = 'a declaration that starts as a use or an extern crate is one rustc refuses, and no module is read from it';
  const CSHARP_NOTE = 'a directive that starts as a using is one the C# compiler refuses, and no namespace is read from it';

  it('holds with the note under it, and fails for it under --strict, as for a Python statement Python refuses', async () => {
    for (const [file, source, note] of [
      ['src/lib.rs', 'use std::fmt;\nuse forbidden::thing c;\n', RUST_NOTE],
      ['src/lib.rs', 'use std::fmt;\nuse forbidden::fn;\n', RUST_NOTE],
      ['src/Shop.cs', 'using System;\nusing forbidden.;\n', CSHARP_NOTE],
      ['src/Shop.cs', 'using System;\nusing class.forbidden;\n', CSHARP_NOTE],
    ]) {
      const lenient = await report(file!, source!, false);
      expect([lenient.ok, lenient.results[0]?.message, lenient.results[0]?.warnings], source).toEqual([
        true,
        'expected no matches, found 0',
        ['1 module reference could not be resolved statically', `  ${file}:2 ${note}`],
      ]);
      const strict = await report(file!, source!, true);
      expect([strict.ok, strict.results[0]?.message], source).toEqual([false, 'expected no matches, found 0; 1 reference could not be resolved']);
    }
  });

  it('passes under --strict over what the compiler takes, with nothing said', async () => {
    for (const [file, source] of [
      ['src/lib.rs', "use std::fmt;\nfn f<'a>(x: &'a u8) -> impl Sized + use<'a> { x }\n"],
      ['src/lib.rs', 'macro_rules! m { ($($t:tt)*) => {}; }\nm! { use #name::Thing; }\n'],
      ['src/lib.rs', 'use kw::async;\n'],
      ['src/Shop.cs', 'using System;\nusing var d = new D();\n'],
      ['src/Shop.cs', 'using System;\nusing T = (int, string);\n'],
      ['src/Shop.cs', '#if NEVER\nusing forbidden.;\n#endif\n'],
    ]) {
      const strict = await report(file!, source!, true);
      expect([strict.ok, strict.results[0]?.warnings], source).toEqual([true, []]);
    }
  });
});

describe('each keyword', () => {
  // Rust's keywords in every edition (Keywords, read on 2026-10-19), each
  // refused by rustc 1.97.1 for a segment and for an alias in the 2015,
  // 2018, 2021 and 2024 editions, where `r#` makes it a name.
  const RUST_KEYWORDS = [
    ...['as', 'break', 'const', 'continue', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop'],
    ...['match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'Self', 'static', 'struct', 'trait', 'true', 'type', 'unsafe'],
    ...['use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized'],
    ...['virtual', 'yield'],
  ];
  // C#'s keywords (6.4.4), each refused by the compiler for a name written
  // plain, and taken written with `@`; and those that name a type, each
  // taken as an alias's type.
  const CSHARP_KEYWORDS = [
    ...['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue'],
    ...['decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally'],
    ...['fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock'],
    ...['long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected'],
    ...['public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string'],
    ...['struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort'],
    ...['using', 'virtual', 'void', 'volatile', 'while'],
  ];
  const CSHARP_TYPES = ['bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte', 'short', 'string', 'uint', 'ulong', 'ushort'];

  it.each(RUST_KEYWORDS.map((word) => [word]))('of Rust, %s, is no segment and no alias, and is one written raw', (word) => {
    expect(rustSaid(`use kw::${word};`)).toEqual([[], REFUSED]);
    expect(rustSaid(`use kw::plain as ${word};`)).toEqual([[], REFUSED]);
    if (word !== 'Self') expect(rustSaid(`use kw::r#${word};`)).toEqual([[[`kw::${word}`, 1]], []]);
  });

  it.each(['self', 'super', 'crate'].map((word) => [word]))('of Rust that a path starts with, %s, is no alias', (word) => {
    expect(rustSaid(`use kw::plain as ${word};`)).toEqual([[], REFUSED]);
  });

  it.each(CSHARP_KEYWORDS.map((word) => [word]))('of C#, %s, is no name written plain, and is one with an @', (word) => {
    expect(csharpSaid(`using KW.${word};`)).toEqual([[], REFUSED]);
    expect(csharpSaid(`using KW.@${word};`)).toEqual([[[`KW.${word}`, 1]], []]);
  });

  it.each(CSHARP_TYPES.map((word) => [word]))('of C# that names a type, %s, is an alias of it, which names no namespace', (word) => {
    expect(csharpSaid(`using T = ${word};`)).toEqual([[], []]);
    expect(csharpSaid(`using T = ${word}[];`)).toEqual([[], []]);
  });
});

describe('how deep a C# type may nest', () => {
  const nested = (depth: number): string => `using T = ${'G.L<'.repeat(depth)}int${'>'.repeat(depth)};\nusing Ui;\n`;

  it('is MAX_EXPANSION types, and one deeper is reported, with no name read, as twenty thousand are', () => {
    expect(csharpSaid(nested(MAX_EXPANSION - 1))).toEqual([[['G.L', 1], ['Ui', 2]], []]);
    for (const depth of [MAX_EXPANSION, 20_000]) expect(csharpSaid(nested(depth)), String(depth)).toEqual([[['Ui', 2]], [['truncated', 1]]]);
    expect(csharpSaid(`using T = ${'('.repeat(20_000)}int, int${', int)'.repeat(20_000)};\n`)).toEqual([[], [['truncated', 1]]]);
    expect(csharpSaid(`using T = ${'G.L<'.repeat(125_000)}\nusing Ui;\n`)).toEqual([[['Ui', 2]], [['truncated', 1]]]);
  });

  it('is a depth, not a count: a thousand types side by side are read', () => {
    expect(csharpSaid(`using T = G.L<${Array.from({ length: 1000 }, () => 'int').join(', ')}>;\n`)).toEqual([[['G.L', 1]], []]);
    expect(csharpSaid(`using T = (${Array.from({ length: 1000 }, () => '(int, int)').join(', ')});\n`)).toEqual([[], []]);
  });
});
