import { afterEach, describe, expect, it } from 'vitest';

import { analyzeSource } from '../src/imports.js';
import { runSpecGuard } from '../src/runner.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';
import { syntaxFor, syntaxNamed } from '../src/comments.js';
import {
  analyzePolyglot,
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
