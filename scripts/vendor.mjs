// Copies third-party code the extension ships into extension/vendor as ES modules.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = readFileSync(`${root}node_modules/jsqr/dist/jsQR.js`, 'utf8');
const { version } = JSON.parse(readFileSync(`${root}node_modules/jsqr/package.json`, 'utf8'));
mkdirSync(`${root}extension/vendor`, { recursive: true });
writeFileSync(`${root}extension/vendor/jsqr.js`, `// jsQR ${version}, https://github.com/cozmo/jsQR
// Copyright 2018 Cosmo Wolfe. Licensed under the Apache License, Version 2.0.
// Wrapped as an ES module for the service worker.
const module = { exports: {} };
const exports = module.exports;
${dist}
const jsQR = module.exports.default || module.exports;
export default jsQR;
`);
console.log(`vendored jsQR ${version}`);
