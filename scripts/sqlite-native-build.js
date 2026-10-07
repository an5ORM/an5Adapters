const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildNative(directory) {
  const source = path.resolve(__dirname, '../native/sqlite');
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('cmake', ['-S', source, '-B', directory, '-DCMAKE_BUILD_TYPE=Release'], { stdio: 'inherit' });
    execFileSync('cmake', ['--build', directory, '--config', 'Release'], { stdio: 'inherit' });
    const dll = path.join(directory, 'Release', 'an5_vector.dll');
    return fs.existsSync(dll) ? dll : path.join(directory, 'an5_vector.dll');
  }
  const binary = path.join(directory, process.platform === 'darwin' ? 'an5_vector.dylib' : 'an5_vector.so');
  const flags = ['-std=c99', '-O3', '-Wall', '-Wextra', '-Werror', '-fPIC',
    process.platform === 'darwin' ? '-dynamiclib' : '-shared'];
  if (process.env.SQLITE_INCLUDE_DIR) flags.push('-I', process.env.SQLITE_INCLUDE_DIR);
  if (process.env.AN5_NATIVE_SANITIZE) flags.push('-fsanitize=undefined', '-fno-sanitize-recover=all');
  execFileSync(process.env.CC || 'cc', [...flags, path.join(source, 'an5_vector.c'), '-lm', '-o', binary], { stdio: 'inherit' });
  return binary;
}

module.exports = { buildNative };
if (require.main === module) {
  try {
    console.log(buildNative(path.resolve(process.argv[2] || path.join(__dirname, '../native/sqlite/build'))));
  } catch (error) {
    console.error('Native vector build requires a C compiler and sqlite3ext.h (Windows: CMake and a C compiler).');
    console.error(error.message);
    process.exitCode = 1;
  }
}
