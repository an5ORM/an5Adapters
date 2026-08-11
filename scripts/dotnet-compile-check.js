#!/usr/bin/env node
/**
 * Compile-check the standalone .NET adapter sources.
 *
 * The npm package ships raw C# files instead of a csproj, so this script copies
 * the shipped sources into a temporary SDK-style project and runs dotnet build.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-dotnet-check-'));

function copy(src, dest) {
  fs.mkdirSync(path.join(tmp, path.dirname(dest)), { recursive: true });
  fs.copyFileSync(path.join(root, src), path.join(tmp, dest));
}

try {
  copy('dotnet/An5Adapter.cs', 'An5Adapter.cs');
  copy('dotnet/Base/Core.cs', 'Base/Core.cs');
  copy('dotnet/Mssql/MssqlEngine.cs', 'Mssql/MssqlEngine.cs');
  copy('dotnet/Postgres/PostgresEngine.cs', 'Postgres/PostgresEngine.cs');

  fs.writeFileSync(
    path.join(tmp, 'An5DotnetCheck.csproj'),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '    <Nullable>disable</Nullable>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <PackageReference Include="Npgsql" Version="8.0.6" />',
      '    <PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.2" />',
      '  </ItemGroup>',
      '</Project>',
      ''
    ].join('\n'),
    'utf8'
  );

  execFileSync('dotnet', ['build', tmp, '--nologo'], { stdio: 'inherit' });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
