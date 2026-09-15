import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  MAX_UPLOAD_BODY_SIZE,
  MAX_UPLOAD_FILE_SIZE,
  uploadBodyLimitMiddleware,
} from '../../src/server/security/upload-body-limit.js';

assert.ok(MAX_UPLOAD_BODY_SIZE > MAX_UPLOAD_FILE_SIZE);

const app = new Hono();
app.post('/upload', uploadBodyLimitMiddleware, (context) => context.text('ok'));

const response = await app.request('/upload', {
  method: 'POST',
  headers: { 'content-length': String(MAX_UPLOAD_BODY_SIZE + 1) },
  body: 'x',
});
assert.equal(response.status, 413);
assert.match(await response.text(), /10 MB/);

console.log('upload-body-limit: 通过');
