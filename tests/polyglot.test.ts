import { afterEach, describe, expect, it } from 'vitest';

import { analyzeSource, moduleNames } from '../src/imports.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';
import { syntaxFor, syntaxNamed } from '../src/comments.js';
import {
  analyzePolyglot,
  enclosingModules,
  expandUsePath,
  languageFor,
  literalValue,
  normalizeModule,
  MAX_EXPANSION,
  POLYGLOT_EXTENSIONS,
  SYNTAX_NAMES,
} from '../src/polyglot.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeTempRepo(files);
  temporary.push(root);
  return root;
}

/** The module paths a source file depends on, in source order. */
function specifiers(source: string, file: string): string[] {
  return analyzeSource(source, file).references.map((reference) => reference.specifier);
}

function notes(source: string, file: string): string[] {
  return analyzeSource(source, file).notes.map((note) => `${note.kind}: ${note.detail}`);
}

describe('languageFor', () => {
  it.each([
    ['app/main.py', 'python'],
    ['stubs/app.pyi', 'python'],
    ['cmd/server.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['Api/Program.cs', 'csharp'],
    ['script.csx', 'csharp'],
    ['SHOUTING.PY', 'python'],
  ])('reads %s as %s', (file, language) => {
    expect(languageFor(file)).toBe(language);
  });

  it.each(['app.ts', 'app.js', 'notes.md', 'data.json', 'Makefile'])('leaves %s to another analyser', (file) => {
    expect(languageFor(file)).toBeNull();
  });
});

describe('python', () => {
  it('reads plain and dotted imports', () => {
    expect(specifiers('import os\nimport app.db.client\n', 'a.py')).toEqual(['os', 'app.db.client']);
  });

  it('reads every module in a comma-separated import', () => {
    expect(specifiers('import app.db as db, app.ui, sys\n', 'a.py')).toEqual(['app.db', 'app.ui', 'sys']);
  });

  it('reads the module of a from-import, not the names', () => {
    expect(specifiers('from app.db import Client, Pool\n', 'a.py')).toEqual(['app.db']);
  });

  it('treats the names of a bare relative import as modules', () => {
    // `from . import db` depends on the sibling module `db`, which
    // `from .pkg import name` could not assume of its names.
    expect(specifiers('from . import db, cache\n', 'app/svc/handler.py')).toEqual(['.db', '.cache']);
  });

  it('reads a parenthesised, multi-line import list', () => {
    const source = 'from app.db import (\n    Client,\n    Pool,\n)\n';
    expect(specifiers(source, 'a.py')).toEqual(['app.db']);
  });

  it('reads a backslash continuation', () => {
    expect(specifiers('from app.db \\\n    import Client\n', 'a.py')).toEqual(['app.db']);
  });

  it('reads an import nested in a function body', () => {
    expect(specifiers('def load():\n    import app.db\n', 'a.py')).toEqual(['app.db']);
  });

  it('reads an import after a colon or a semicolon', () => {
    expect(specifiers('if TYPE_CHECKING: import app.db\nimport os; import sys\n', 'a.py')).toEqual([
      'app.db',
      'os',
      'sys',
    ]);
  });

  it('ignores an import inside a comment', () => {
    expect(specifiers('# import app.db\nimport os\n', 'a.py')).toEqual(['os']);
  });

  it('ignores an import inside a docstring', () => {
    // The exact shape that broke text search: prose about a dependency is not
    // a dependency. A docstring is a string, not a comment, so this is only
    // right because the lexer tracks both.
    const source = '"""Example:\n\n    import app.db\n"""\nimport os\n';
    expect(specifiers(source, 'a.py')).toEqual(['os']);
  });

  it('ignores a module name inside an ordinary string', () => {
    expect(specifiers('MESSAGE = "import app.db to continue"\nimport os\n', 'a.py')).toEqual(['os']);
  });

  it('does not read "from" in a raise or a yield', () => {
    expect(specifiers('raise ValueError() from err\n', 'a.py')).toEqual([]);
    expect(specifiers('def g():\n    yield from other()\n', 'a.py')).toEqual([]);
  });

  it('does not read an identifier that merely starts with import', () => {
    expect(specifiers('importer = 1\nimportlib_hint = 2\n', 'a.py')).toEqual([]);
  });

  it('reads a dynamic import with a literal name', () => {
    expect(specifiers('mod = importlib.import_module("app.db")\n', 'a.py')).toEqual(['app.db']);
    expect(specifiers('mod = __import__("app.ui")\n', 'a.py')).toEqual(['app.ui']);
  });

  it('reports a dynamic import whose name is computed', () => {
    expect(notes('mod = importlib.import_module(name)\n', 'a.py')).toEqual([
      'dynamic: import_module(...) with a computed name',
    ]);
  });

  it('resolves relative imports against the importing file', () => {
    expect(normalizeModule('.db', 'app/svc/handler.py', 'python')).toBe('app/svc/db');
    expect(normalizeModule('..core.auth', 'app/svc/handler.py', 'python')).toBe('app/core/auth');
    expect(normalizeModule('...root', 'app/a/b/c.py', 'python')).toBe('app/root');
  });

  it('resolves an absolute import to a path', () => {
    expect(normalizeModule('app.db.client', 'anywhere.py', 'python')).toBe('app/db/client');
  });
});

describe('go', () => {
  it('reads a single import', () => {
    expect(specifiers('package main\n\nimport "fmt"\n', 'a.go')).toEqual(['fmt']);
  });

  it('reads a grouped import block', () => {
    const source = 'import (\n\t"fmt"\n\t"github.com/x/y/db"\n)\n';
    expect(specifiers(source, 'a.go')).toEqual(['fmt', 'github.com/x/y/db']);
  });

  it('reads aliased, blank and dot imports', () => {
    const source = 'import (\n\tf "fmt"\n\t_ "database/sql"\n\t. "strings"\n)\n';
    expect(specifiers(source, 'a.go')).toEqual(['fmt', 'database/sql', 'strings']);
  });

  it('reads an aliased single import', () => {
    expect(specifiers('import f "fmt"\n', 'a.go')).toEqual(['fmt']);
    expect(specifiers('import _ "embed"\n', 'a.go')).toEqual(['embed']);
  });

  it('ignores an import inside a comment', () => {
    expect(specifiers('// import "fmt"\nimport "os"\n', 'a.go')).toEqual(['os']);
    expect(specifiers('/*\nimport "fmt"\n*/\nimport "os"\n', 'a.go')).toEqual(['os']);
  });

  it('ignores an import inside a raw string', () => {
    const source = 'var doc = `\nimport "fmt"\n`\nimport "os"\n';
    expect(specifiers(source, 'a.go')).toEqual(['os']);
  });

  it('does not read a word that merely contains import', () => {
    expect(specifiers('func importAll() {}\nvar reimport = 1\n', 'a.go')).toEqual([]);
  });

  it('leaves go paths alone: they are already slash-separated', () => {
    expect(normalizeModule('github.com/x/y', 'a.go', 'go')).toBe('github.com/x/y');
  });
});

describe('rust', () => {
  it('reads a simple use declaration', () => {
    expect(specifiers('use std::fmt;\n', 'a.rs')).toEqual(['std::fmt']);
  });

  it('expands a brace group', () => {
    expect(specifiers('use crate::db::{client, pool};\n', 'a.rs')).toEqual(['crate::db::client', 'crate::db::pool']);
  });

  it('expands nested brace groups', () => {
    expect(specifiers('use a::{b::{c, d}, e};\n', 'a.rs')).toEqual(['a::b::c', 'a::b::d', 'a::e']);
  });

  it('expands self inside a group to the group prefix', () => {
    expect(specifiers('use std::io::{self, Read};\n', 'a.rs')).toEqual(['std::io', 'std::io::Read']);
  });

  it('drops the alias but keeps the path', () => {
    expect(specifiers('use crate::db::Client as C;\n', 'a.rs')).toEqual(['crate::db::Client']);
  });

  it('reads pub use and pub(crate) use', () => {
    expect(specifiers('pub use crate::a;\npub(crate) use crate::b;\n', 'a.rs')).toEqual(['crate::a', 'crate::b']);
  });

  it('reads extern crate', () => {
    expect(specifiers('extern crate serde;\n', 'a.rs')).toEqual(['serde']);
  });

  it('reads a glob import', () => {
    expect(specifiers('use crate::prelude::*;\n', 'a.rs')).toEqual(['crate::prelude::*']);
  });

  it('reads a use inside a function body', () => {
    expect(specifiers('fn f() {\n    use crate::db::Client;\n}\n', 'a.rs')).toEqual(['crate::db::Client']);
  });

  it('ignores a use inside a nested block comment', () => {
    // Rust block comments nest, so the inner */ does not close the outer
    // comment - the reason RUST is the one syntax with nested: true.
    expect(specifiers('/* outer /* inner */ use crate::hidden; */\nuse crate::real;\n', 'a.rs')).toEqual([
      'crate::real',
    ]);
  });

  it('ignores a use inside a raw string', () => {
    expect(specifiers('const D: &str = r#"use crate::hidden;"#;\nuse crate::real;\n', 'a.rs')).toEqual([
      'crate::real',
    ]);
  });

  it('does not read a word that merely starts with use', () => {
    expect(specifiers('let used = 1;\nfn user() {}\n', 'a.rs')).toEqual([]);
  });

  it('reports rather than truncates an expansion that would explode', () => {
    // Nesting multiplies, so the guard is a cap plus a note, not a silent
    // partial read: half a use declaration is a rule that quietly stops
    // covering things.
    const wide = `use a::{${Array.from({ length: MAX_EXPANSION + 5 }, (_, i) => `m${i}`).join(', ')}};\n`;
    const analysis = analyzeSource(wide, 'a.rs');
    expect(analysis.references).toEqual([]);
    expect(analysis.notes[0]?.kind).toBe('truncated');
  });

  it('caps a deeply nested expansion instead of exhausting memory', () => {
    let source = 'x';
    for (let depth = 0; depth < 8; depth++) source = `{${source}::a, ${source}::b}`;
    expect(expandUsePath(source)).toBeNull();
  });

  // The shape of the trial file, with its names changed: a plugin crate whose
  // uses sit among lifetimes, character literals, raw strings and comments
  // with contractions. 0.10.2 read one use of these seven and said nothing.
  const PLUGIN = [
    '//! A rules plugin: the dice it rolls and the sheets it reads.',
    '',
    'use engine_api::dice::Roll;',
    '',
    "pub struct Skill<'a> {",
    "    name: &'a str,",
    '}',
    '',
    'impl Plugin for Rules {',
    "    fn id(&self) -> &'static str {",
    '        "rules"',
    '    }',
    '}',
    '',
    "// The sheet's layout doesn't change between editions.",
    'use engine_api::sheet::{Field, Sheet};',
    'use engine_api::chat::Message;',
    '',
    "fn lines(text: &str) -> impl Iterator<Item = &str> + '_ {",
    '    text.lines()',
    '}',
    '',
    "fn longest<'a, 'b>(x: &'a str, y: &'b str) -> &'a str where 'b: 'a {",
    "    'scan: for c in x.chars() {",
    "        if c == '\\'' || c == '\"' { break 'scan; }",
    '    }',
    '    x',
    '}',
    '',
    'const HELP: &str = r##"Say "#roll" - use engine_api::hidden; is not a use."##;',
    '',
    "use engine_api::tokens::Token; // it's the last one",
    '',
  ].join('\n');

  it('reads every use among lifetimes, character literals, raw strings and contractions', () => {
    const analysis = analyzeSource(PLUGIN, 'plugins/rules/src/lib.rs');

    expect(analysis.references.map((reference) => reference.specifier)).toEqual([
      'engine_api::dice::Roll',
      'engine_api::sheet::Field',
      'engine_api::sheet::Sheet',
      'engine_api::chat::Message',
      'engine_api::tokens::Token',
    ]);
    expect(analysis.notes).toEqual([]);
  });

  it.each([
    ['a static lifetime', "fn id() -> &'static str { \"x\" }"],
    ['the anonymous lifetime', "impl Display for Row<'_> {}"],
    ['a named lifetime', "fn first<'a>(s: &'a str) -> &'a str { s }"],
    ['a lifetime bound', "struct Ref<'a, T: 'a> { r: &'a T }"],
    ['an outlives bound', "fn f<'a, 'b>(x: &'a str) where 'a: 'b {}"],
  ])('reads a use after %s and a comment with a contraction', (_name, code) => {
    // An odd number of quotes before the uses and one after them: the last of
    // them and the apostrophe made a character literal of everything between.
    const source = `${code}\nuse crate::db::Pool;\nuse crate::db::Client;\n// don't\n`;
    expect(specifiers(source, 'a.rs')).toEqual(['crate::db::Pool', 'crate::db::Client']);
    expect(notes(source, 'a.rs')).toEqual([]);
  });

  it('reads a use after an escaped quote character', () => {
    expect(specifiers("let q = '\\'';\nuse crate::after;\n// it's\n", 'a.rs')).toEqual(['crate::after']);
  });

  it('ignores a use inside a raw string of any number of hashes, and reads the one after it', () => {
    const source = 'const S: &str = r###"a "## use crate::hidden; "#"###;\nuse crate::real;\n';
    expect(specifiers(source, 'a.rs')).toEqual(['crate::real']);
    expect(notes(source, 'a.rs')).toEqual([]);
  });

  it('reads the uses after a character literal left open, and reports the file', () => {
    // Not valid Rust, so no compiler would take it; but it now costs the rest
    // of one line rather than the rest of the file, and it is still reported.
    const source = "let c = '\\u{41;\nuse crate::after;\n";
    expect(specifiers(source, 'a.rs')).toEqual(['crate::after']);
    expect(notes(source, 'a.rs')).toEqual(['unreadable: a string or comment was never closed, so its imports are not trustworthy']);
  });

  it('matches crate-relative paths after normalisation', () => {
    expect(normalizeModule('crate::db::client', 'src/ui/w.rs', 'rust')).toBe('crate/db/client');
    // Documented limitation: module-relative paths are matched as written,
    // because resolving them needs the module tree, not the file tree.
    expect(normalizeModule('super::db', 'src/ui/w.rs', 'rust')).toBe('super/db');
  });
});

describe('c#', () => {
  it('reads a using directive', () => {
    expect(specifiers('using System;\nusing System.Text.Json;\n', 'a.cs')).toEqual(['System', 'System.Text.Json']);
  });

  it('reads using static', () => {
    expect(specifiers('using static System.Math;\n', 'a.cs')).toEqual(['System.Math']);
  });

  it('reads the target of an alias, not the alias', () => {
    expect(specifiers('using Json = System.Text.Json;\n', 'a.cs')).toEqual(['System.Text.Json']);
  });

  it('reads an alias whose target is generic', () => {
    expect(specifiers('using Ints = System.Collections.Generic.List<int>;\n', 'a.cs')).toEqual([
      'System.Collections.Generic.List',
    ]);
  });

  it('reads a global using', () => {
    expect(specifiers('global using System.Linq;\n', 'a.cs')).toEqual(['System.Linq']);
  });

  it('does not read a using statement', () => {
    // `using (...)` and `using var` are resource scopes. Reading either as a
    // dependency would make every C# file that opens a stream look like it
    // imports one.
    expect(specifiers('using (var s = File.OpenRead(p)) { }\n', 'a.cs')).toEqual([]);
    expect(specifiers('using var stream = File.OpenRead(p);\n', 'a.cs')).toEqual([]);
    expect(specifiers('await using var conn = Open();\n', 'a.cs')).toEqual([]);
  });

  it('does not read a using declaration whose name merely looks like a namespace', () => {
    expect(specifiers('using var reader = new StreamReader(p);\n', 'a.cs')).toEqual([]);
  });

  it('ignores a using inside a comment or a verbatim string', () => {
    expect(specifiers('// using System.Hidden;\nusing System.Real;\n', 'a.cs')).toEqual(['System.Real']);
    expect(specifiers('var s = @"using System.Hidden;";\nusing System.Real;\n', 'a.cs')).toEqual(['System.Real']);
  });

  it('does not read a word that merely starts with using', () => {
    expect(specifiers('var usingCount = 1;\n', 'a.cs')).toEqual([]);
  });

  it('normalises dotted namespaces to paths', () => {
    expect(normalizeModule('System.Text.Json', 'a.cs', 'csharp')).toBe('System/Text/Json');
  });

  it('reads the namespace a global:: or extern alias qualifier looks in, without the qualifier', () => {
    // `global.Shop.Application` was the specifier before 0.10.2, and a rule
    // about Shop.Application never saw it.
    expect(
      specifiers(
        'extern alias Legacy;\nglobal using global::Shop.Application;\nusing Legacy::Shop.Domain;\nusing Json = global::System.Text.Json;\n',
        'a.cs',
      ),
    ).toEqual(['Shop.Application', 'Shop.Domain', 'System.Text.Json']);
  });

  it('reads the usings after a string C# 11 or C# 8 wrote, and none inside one', () => {
    const source = [
      'var sql = """',
      '    using Shop.Hidden;',
      '    say "hi"',
      '    """;',
      'var four = """"',
      '    using Shop.AlsoHidden; """ still inside',
      '    """";',
      'var path = @$"C:\\";',
      'namespace Shop.Web { using Shop.Real; }',
    ].join('\n');

    expect(analyzeSource(source, 'a.cs')).toMatchObject({ notes: [], references: [{ specifier: 'Shop.Real', line: 9 }] });
    expect(analyzeSource(source, 'a.cs').references).toHaveLength(1);
  });
});

describe('the namespaces a c# file declares', () => {
  const declared = (source: string): string[] | undefined => analyzeSource(source, 'a.cs').namespaces;

  it('reads a file-scoped namespace and a block one', () => {
    expect(declared('namespace Shop.Domain.Orders;\n\npublic class Order { }\n')).toEqual(['Shop.Domain.Orders']);
    expect(declared('namespace Shop.Domain\n{\n    public class Order { }\n}\n')).toEqual(['Shop.Domain']);
  });

  it('names a block inside another in full, and a block after one closes on its own', () => {
    const source = 'namespace Shop { class A { } namespace Domain { } }\nnamespace Billing { }\n';
    expect(declared(source)).toEqual(['Shop', 'Shop.Domain', 'Billing']);
  });

  it('lists a namespace declared twice once', () => {
    expect(declared('namespace A { }\nnamespace A { }\n')).toEqual(['A']);
  });

  it('declares nothing for the identifier @namespace, or a namespace with no body', () => {
    expect(declared('var x = @namespace;\nreturn @namespace { };\n')).toEqual([]);
    expect(declared('namespace Broken\n')).toEqual([]);
  });

  it('ignores a namespace in a comment or a string', () => {
    expect(declared('// namespace Hidden;\nvar s = "namespace Hidden;";\nnamespace Real;\n')).toEqual(['Real']);
  });

  it('is only said of c#', () => {
    expect(analyzeSource('import app.db\n', 'a.py').namespaces).toBeUndefined();
    expect(analyzeSource("import './a.js';\n", 'a.ts').namespaces).toBeUndefined();
  });
});

describe('the namespace a c# using sits in', () => {
  const inside = (source: string): Array<string | undefined> =>
    analyzeSource(source, 'a.cs').references.map((reference) => reference.namespace);

  it('is nothing for a using before a file-scoped namespace, and the namespace for one after it', () => {
    expect(inside('using Top;\nnamespace Shop.Domain;\nusing Inside;\n')).toEqual([undefined, 'Shop.Domain']);
  });

  it('is the innermost block around it, and nothing once the blocks have closed', () => {
    const source = [
      'namespace Shop {',
      '  using One;',
      '  class A { void M() { } }',
      '  namespace Domain { using Two; }',
      '  namespace Billing { using Three; }',
      '}',
      'using Four;',
    ].join('\n');

    expect(inside(source)).toEqual(['Shop', 'Shop.Domain', 'Shop.Billing', undefined]);
  });

  it('survives a brace that closes something no namespace opened', () => {
    expect(inside('}\nusing Stray;\nnamespace A { using B; }\n')).toEqual([undefined, 'A']);
  });
});

describe('enclosingModules', () => {
  it.each([
    ['Shop.Application.Catalog', 'csharp', ['Shop.Application', 'Shop']],
    ['app.db.client', 'python', ['app.db', 'app']],
    ['crate::db::client', 'rust', ['crate::db', 'crate']],
    ['Shop', 'csharp', []],
    // A relative import is matched by the path it resolves to.
    ['..core.models', 'python', []],
    // A Go import path carries its hierarchy in its slashes, and its dots are a host name.
    ['github.com/o/r/db', 'go', []],
  ] as const)('%s in %s sits under %j', (specifier, language, expected) => {
    expect(enclosingModules(specifier, language)).toEqual(expected);
  });
});

describe('moduleNames', () => {
  it('is the specifier and its resolved form for javascript', () => {
    expect(moduleNames('../db/client.js', 'src/ui/view.ts')).toEqual(['../db/client.js', 'src/db/client.js']);
  });

  it('adds the modules a dotted name sits under, in its own notation', () => {
    expect(moduleNames('Shop.Application.Catalog', 'src/A.cs')).toEqual([
      'Shop.Application.Catalog',
      'Shop/Application/Catalog',
      'Shop.Application',
      'Shop',
    ]);
    expect(moduleNames('crate::db::client', 'src/lib.rs')).toEqual(['crate::db::client', 'crate/db/client', 'crate::db', 'crate']);
  });

  it('adds what a using inside a namespace may resolve to there, nearest first', () => {
    expect(moduleNames('Catalog', 'src/A.cs', 'Shop.Application')).toEqual([
      'Catalog',
      'Catalog',
      'Shop.Application.Catalog',
      'Shop/Application/Catalog',
      'Shop.Application',
      'Shop',
      'Shop.Catalog',
      'Shop/Catalog',
      'Shop',
    ]);
  });
});

describe('lost scans', () => {
  it.each([
    ['a.py', 'x = "open\nimport os\n'],
    ['a.go', 'var d = `open\nimport "os"\n'],
    ['a.rs', 'const D: &str = "open;\nuse crate::real;\n'],
    ['a.cs', 'var s = @"open;\nusing System.Real;\n'],
  ])('reports an unterminated literal in %s rather than concluding there are no imports', (file, source) => {
    const analysis = analyzeSource(source, file);
    expect(analysis.notes.map((note) => note.kind)).toContain('unreadable');
  });

  it('reports an unterminated block comment', () => {
    const analysis = analyzeSource('/* never closed\nusing System.Real;\n', 'a.cs');
    expect(analysis.references).toEqual([]);
    expect(analysis.notes.map((note) => note.kind)).toContain('unreadable');
  });
});

describe('locations', () => {
  it('reports the line the statement is on', () => {
    const source = '\n\n\nimport app.db\n';
    expect(analyzeSource(source, 'a.py').references[0]).toMatchObject({ line: 4, column: 1 });
  });

  it('reports the line of a grouped go import, not the group', () => {
    const analysis = analyzeSource('package m\n\nimport (\n\t"fmt"\n)\n', 'a.go');
    expect(analysis.references[0]).toMatchObject({ specifier: 'fmt', line: 3 });
  });

  it('names the kind of each reference', () => {
    expect(analyzeSource('use a::b;\n', 'a.rs').references[0]?.kind).toBe('use');
    expect(analyzeSource('using A.B;\n', 'a.cs').references[0]?.kind).toBe('using');
    expect(analyzeSource('import "os"\n', 'a.go').references[0]?.kind).toBe('import');
  });
});

describe('literalValue', () => {
  it.each([
    ['"fmt"', 'fmt'],
    ["'fmt'", 'fmt'],
    ['`fmt`', 'fmt'],
    ['"""doc"""', 'doc'],
    ["'''doc'''", 'doc'],
    ['@"verbatim"', 'verbatim'],
    ['r"raw"', 'raw'],
    ['r#"raw"#', 'raw'],
    ['r##"say "#hi""##', 'say "#hi"'],
    ['r###"raw"###', 'raw'],
    // An ordinary string that merely ends in `r"` is not a raw one.
    ['"bar"', 'bar'],
  ])('strips the delimiters of %s', (raw, value) => {
    expect(literalValue(raw)).toBe(value);
  });
});

describe('expandUsePath', () => {
  it('returns nothing for an empty path', () => {
    expect(expandUsePath('  ;  ')).toEqual([]);
    expect(expandUsePath('{}')).toEqual([]);
  });

  it('handles a leading separator', () => {
    expect(expandUsePath('::a::b')).toEqual(['a::b']);
  });

  it('handles a brace group with no prefix', () => {
    expect(expandUsePath('{a, b}')).toEqual(['a', 'b']);
  });
});

describe('analyzePolyglot', () => {
  it('reads by the language it was given, not by the path it was handed', () => {
    // A file with no recognisable extension still analyses correctly, because
    // the comment profile follows the language argument rather than the name.
    expect(analyzePolyglot('use a::b;\n', 'weird-name', 'rust').references[0]?.specifier).toBe('a::b');
  });

  it('picks the same comment profile by language as by extension', () => {
    // The parity that keeps one question from having two answers: however the
    // profile is looked up, it is the same profile.
    for (const [extension, language] of POLYGLOT_EXTENSIONS) {
      const byExtension = syntaxFor(`file${extension}`);
      const byLanguage = syntaxNamed(SYNTAX_NAMES[language]);
      expect(byLanguage, `${extension} -> ${language}`).toBe(byExtension);
      expect(byLanguage).not.toBeNull();
    }
  });
});

describe('through a directive', () => {
  it('catches a forbidden dependency in every supported language at once', async () => {
    // The claim under test is the one the assertion actually makes: "the UI
    // layer does not depend on the database layer". Four languages, one rule,
    // one answer.
    //
    // Two patterns, not one, because matching is case-sensitive and C#
    // capitalises namespaces where Go and Python do not. A polyglot rule has
    // to name both conventions; pretending otherwise would be a rule that
    // silently stops covering the C# half of the repository.
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="ui" module="app/db/** App/Db/**" -->\n',
      'ui/view.py': 'from app.db.client import Client\n',
      'ui/view.go': 'import "app/db/client"\n',
      'ui/view.rs': 'use app::db::client;\n',
      'ui/View.cs': 'using App.Db.Client;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.actual).toBe(4);
    expect(report.results[0]?.matches.map((match) => match.file).sort()).toEqual([
      'ui/View.cs',
      'ui/view.go',
      'ui/view.py',
      'ui/view.rs',
    ]);
  });

  it('matches a namespace written in the language own notation', async () => {
    // A C# author writes System.Text, not System/Text. Both forms resolve.
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence target="api" module="System.Text.Json" -->\n',
      'docs/b.md': '<!-- @assert-import-absence target="api" module="System/Text/Json" -->\n',
      'api/Program.cs': 'using System.Text.Json;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.results.map((result) => result.actual)).toEqual([1, 1]);
  });

  it('covers what sits under a dotted module, as the slashed form always did', async () => {
    // `module="Shop.Application"` quietly missed `using Shop.Application.Catalog;`
    // until 0.10.2, while `module="Shop/Application"` caught it.
    const root = await repo({
      'docs/dotted.md': '<!-- @assert-import-count target="src" module="Shop.Application" expected="4" -->\n',
      'docs/slashed.md': '<!-- @assert-import-count target="src" module="Shop/Application" expected="4" -->\n',
      'src/Shop.Domain/Orders/Order.cs': 'using Shop.Application.Catalog;\nnamespace Shop.Domain.Orders;\n',
      'src/Shop.Domain/Orders/Line.cs': 'using Shop.Application;\nnamespace Shop.Domain.Orders;\n',
      'src/Shop.Domain/Orders/Global.cs': 'global using global::Shop.Application.Catalog.Queries;\n',
      // Inside `namespace Shop.Domain`, `Application.Catalog` may be `Shop.Application.Catalog`.
      'src/Shop.Domain/Orders/Relative.cs': 'namespace Shop.Domain\n{\n    using Application.Catalog;\n}\n',
      // The controls: a namespace that only starts with the same letters, and the domain's own.
      'src/Shop.Domain/Orders/Services.cs': 'using Shop.ApplicationServices;\nnamespace Shop.Domain.Orders;\n',
      'src/Shop.Domain/Orders/Own.cs': 'using Shop.Domain.Common;\nnamespace Shop.Domain.Orders;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.results.map((result) => [result.ok, result.actual])).toEqual([
      [true, 4],
      [true, 4],
    ]);
    expect(report.results[0]?.matches.map((match) => match.text).sort()).toEqual([
      'using Application.Catalog',
      'using Shop.Application',
      'using Shop.Application.Catalog',
      'using Shop.Application.Catalog.Queries',
    ]);
  });

  it('covers what sits under a dotted module in python and rust too', async () => {
    const root = await repo({
      'docs/py.md': '<!-- @assert-import-count target="svc" module="app.db" expected="2" -->\n',
      'docs/rs.md': '<!-- @assert-import-count target="svc" module="crate::db" expected="1" -->\n',
      'svc/a.py': 'import app.db.client\n',
      'svc/b.py': 'from app.db import pool\n',
      'svc/c.py': 'from app.dbx import other\n',
      'svc/d.rs': 'use crate::db::pool::Pool;\nuse crate::dbx::Other;\n',
      'svc/e.rs': 'use crate::dbx::Other;\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });

    expect(report.results.map((result) => [result.ok, result.actual])).toEqual([
      [true, 2],
      [true, 1],
    ]);
  });

  it('counts a file once however many times it names the module', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-count target="svc" module="app/db/**" expected="1" -->\n',
      'svc/handler.py': 'from app.db import a\nfrom app.db.pool import b\nimport app.db.client\n',
    });

    expect((await runSpecGuard({ patterns: ['docs/a.md'], root, engine: 'javascript' })).ok).toBe(true);
  });

  it('passes cleanly when nothing in scope depends on the module', async () => {
    // The negative control: the same rule over the same tree, with the
    // dependency removed, must pass - otherwise the test above proves nothing.
    const root = await repo({
      'docs/adr.md': '<!-- @assert-import-absence target="ui" module="app/db/**" -->\n',
      'ui/view.py': 'from app.widgets import button\n',
      'ui/view.go': 'import "app/widgets"\n',
      'ui/view.rs': 'use app::widgets::button;\n',
      'ui/View.cs': 'using App.Widgets;\n',
    });

    expect((await runSpecGuard({ patterns: ['docs/adr.md'], root, engine: 'javascript' })).ok).toBe(true);
  });

  it('fails under --strict when a python import is computed', async () => {
    const root = await repo({
      'docs/a.md': '<!-- @assert-import-absence target="svc" module="app/db/**" -->\n',
      'svc/loader.py': 'import importlib\nmod = importlib.import_module(name)\n',
    });

    const report = await runSpecGuard({
      patterns: ['docs/a.md'],
      root,
      engine: 'javascript',
      strictTargets: true,
    });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.message).toContain('could not be resolved');
  });
});

describe('what a module pattern covers', () => {
  it('does not match the package itself with a /** pattern', async () => {
    // gitignore semantics, and the trap worth knowing: `app/db/**` covers what
    // is inside app/db, not app/db. `from app.db import x` depends on the
    // package, so a rule meaning "nothing under here, including here" has to
    // say both. Pinned as a test because the alternative is finding out from a
    // rule that silently covered less than its author thought.
    const root = await repo({
      'docs/narrow.md': '<!-- @assert-import-absence target="ui" module="app/db/**" -->\n',
      'docs/whole.md': '<!-- @assert-import-absence target="ui" module="app/db app/db/**" -->\n',
      'ui/view.py': 'from app.db import client\n',
    });

    const report = await runSpecGuard({ patterns: ['docs/*.md'], root, engine: 'javascript' });
    const byFile = Object.fromEntries(
      report.results.map((result) => [result.location.relativeFile, result.actual]),
    );

    expect(byFile['docs/narrow.md']).toBe(0);
    expect(byFile['docs/whole.md']).toBe(1);
  });
});

describe('a namespace that starts with a keyword', () => {
  it('does not mistake staticfiles for using static', () => {
    // `eat('static')` matched the first six characters and the dependency came
    // back as `files`. Word boundaries, not prefixes.
    expect(specifiers('using staticfiles.Config;\n', 'a.cs')).toEqual(['staticfiles.Config']);
  });

  it('still reads a real using static', () => {
    expect(specifiers('using static System.Math;\n', 'a.cs')).toEqual(['System.Math']);
  });

  it('does not mistake a crate named extern_helper for extern crate', () => {
    expect(specifiers('use externals::helper;\n', 'a.rs')).toEqual(['externals::helper']);
  });
});
