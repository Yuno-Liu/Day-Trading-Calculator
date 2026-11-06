// 讓 `node --test tests/` 在 Node ≥ 21 也能執行：新版 test runner 把目錄參數當成模組載入，
// CommonJS 會解析到本檔，再由本檔載入同目錄所有 *.test.mjs／*.test.cjs／*.test.js。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

for (const name of fs.readdirSync(__dirname).filter((n) => /\.test\.(?:mjs|cjs|js)$/.test(n)).sort()) {
  import(pathToFileURL(path.join(__dirname, name)).href).catch((err) => {
    process.exitCode = 1;
    console.error(err);
  });
}
