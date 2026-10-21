// 使用 Electron 内置的 Node（含 node:sqlite + FTS5）运行单元测试
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');
const r = spawnSync(electron, ['--test', '--test-reporter=spec', path.join(__dirname, '..', 'tests', 'core.test.js')], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status === null ? 1 : r.status);
