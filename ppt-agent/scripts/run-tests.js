// 使用 Electron 内置的 Node（含 node:sqlite + FTS5）运行单元测试
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');
// Electron 不支持部分 Node 命令行参数（如 --use-openssl-ca），运行测试时去掉 NODE_OPTIONS
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env.NODE_OPTIONS;
const r = spawnSync(electron, ['--test', '--test-reporter=spec', '--test-timeout=180000', path.join(__dirname, '..', 'tests', 'core.test.js')], { stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
