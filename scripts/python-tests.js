const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);
if (!python) throw new Error('Python 3 is required for runtime tests');
for (const args of [["-m", "compileall", "-q", "python"], ["test/python/query_semantics.py"], ["test/python/sqlite_smoke.py"]]) {
  execFileSync(python, args, { cwd: root, stdio: 'inherit' });
}
