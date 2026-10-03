#!/usr/bin/env node
/**
 * Runtime smoke test for the .NET adapter against a real SQLite database.
 *
 * dotnet-compile-check.js proves the sources compile; this proves they work.
 * It builds a temporary project from the shipped C# files plus a test program,
 * runs it, and fails on a non-zero exit.
 *
 * What it covers, and why each case is here:
 *   - dialect detection, because a misdetected string silently produces MSSQL
 *     SQL that SQLite rejects
 *   - connection string normalisation, since Microsoft.Data.Sqlite only reads
 *     `Data Source=`
 *   - take/skip pagination, which is the syntax difference most likely to slip
 *     through: SQLite has no SELECT TOP and no OFFSET/FETCH
 *   - rollback, which only means anything if commit and rollback run on the
 *     same open connection
 *   - stored procedures, which SQLite does not have
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-dotnet-sqlite-'));

function copy(src, dest) {
  fs.mkdirSync(path.join(tmp, path.dirname(dest)), { recursive: true });
  fs.copyFileSync(path.join(root, src), path.join(tmp, dest));
}

try {
  copy('dotnet/An5Adapter.cs', 'An5Adapter.cs');
  copy('dotnet/Base/Core.cs', 'Base/Core.cs');
  copy('dotnet/Mssql/MssqlEngine.cs', 'Mssql/MssqlEngine.cs');
  copy('dotnet/Postgres/PostgresEngine.cs', 'Postgres/PostgresEngine.cs');
  copy('dotnet/Sqlite/SqliteEngine.cs', 'Sqlite/SqliteEngine.cs');
  copy('test/dotnet/Program.cs', 'Program.cs');
  copy('test/fixtures/query-semantics.json', 'query-semantics.json');

  fs.writeFileSync(
    path.join(tmp, 'An5DotnetSqliteSmoke.csproj'),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '    <Nullable>disable</Nullable>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <None Update="query-semantics.json" CopyToOutputDirectory="PreserveNewest" />',
      '    <PackageReference Include="Npgsql" Version="8.0.6" />',
      '    <PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.2" />',
      '    <PackageReference Include="Microsoft.Data.Sqlite" Version="9.0.0" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n'),
    'utf8'
  );

  execFileSync('dotnet', ['run', '--project', tmp, '--nologo'], { stdio: 'inherit' });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
