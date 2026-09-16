import { registerApiRoute } from '@mastra/core/server';
import { withAuthenticatedWorkspace } from '../../modules/auth/workspace-context.js';
import { recordFileSource, recordTextSource, recordUrlSource, SensitiveSourceRejectedError, SourceRejectedError } from '../../modules/sources/service.js';
import { isRecordIntent } from '../../modules/sources/record-intent.js';
import { uploadBodyLimitMiddleware, MAX_UPLOAD_FILE_SIZE } from '../security/upload-body-limit.js';

export const recordSourceRoute = registerApiRoute('/sources/record', {
  method: 'POST', requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (auth, context) => {
    const body = await context.req.json<{ content?: unknown; title?: unknown }>();
    if (typeof body.content !== 'string' || body.content.trim().length === 0 || body.content.length > 20_000) return context.json({ message: '记录内容必须是 1 到 20000 个字符。' }, 422);
    if (!isRecordIntent(body.content)) return context.json({ message: '未识别到明确的记录意图。' }, 422);
    try { return context.json(await recordTextSource(auth.workspaceId, body.content, typeof body.title === 'string' ? body.title : undefined), 201); }
    catch (error) { if (error instanceof SensitiveSourceRejectedError) return context.json({ error_code: 'SENSITIVE_SOURCE_REJECTED', message: error.message }, 422); throw error; }
  }),
});

export const recordFileSourceRoute = registerApiRoute('/sources/file', {
  method: 'POST', requiresAuth: true,
  middleware: uploadBodyLimitMiddleware as unknown as NonNullable<Parameters<typeof registerApiRoute>[1]['middleware']>,
  handler: withAuthenticatedWorkspace(async (auth, context) => {
    const formData = await context.req.formData();
    const intent = formData.get('intent');
    const intentText = typeof intent === 'string' ? intent : '';
    const file = formData.get('file');
    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
      return context.json({ error_code: 'INPUT_VALIDATION_FAILED', message: '请使用 file 字段上传文件。' }, 400);
    }
    const f = file as File;
    if (f.size === 0) return context.json({ error_code: 'INPUT_VALIDATION_FAILED', message: '不允许上传空文件。' }, 400);
    if (f.size > MAX_UPLOAD_FILE_SIZE) return context.json({ error_code: 'INPUT_VALIDATION_FAILED', message: '文件不能超过 10 MB。' }, 400);
    if (!isRecordIntent(intentText || f.name)) {
      return context.json({ error_code: 'UNSUPPORTED_ATTACHMENT_QA', message: '临时附件问答尚未实现，请明确表达记录意图（如"记录这个文件"）。' }, 422);
    }
    const buf = Buffer.from(new Uint8Array(await f.arrayBuffer()));
    try {
      const result = await recordFileSource(auth.workspaceId, { filename: f.name, mimeType: f.type, buffer: buf });
      return context.json(result, 201);
    } catch (err) {
      if (err instanceof SensitiveSourceRejectedError) return context.json({ error_code: 'SENSITIVE_SOURCE_REJECTED', message: err.message }, 422);
      if (err instanceof SourceRejectedError) return context.json({ error_code: 'UNSUPPORTED_SOURCE_FORMAT', message: err.message }, 422);
      throw err;
    }
  }),
});

export const recordUrlSourceRoute = registerApiRoute('/sources/url', {
  method: 'POST', requiresAuth: true,
  handler: withAuthenticatedWorkspace(async (auth, context) => {
    const body = await context.req.json<{ url?: unknown; intent?: unknown }>();
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const intent = typeof body.intent === 'string' ? body.intent : '';
    if (!url || url.length > 2048) return context.json({ error_code: 'INPUT_VALIDATION_FAILED', message: 'url 必须是非空字符串，长度 ≤ 2048。' }, 422);
    if (!isRecordIntent(intent)) {
      return context.json({ error_code: 'UNSUPPORTED_ATTACHMENT_QA', message: '临时附件问答尚未实现，请明确表达记录意图（如"记录这个 URL"）。' }, 422);
    }
    try {
      const result = await recordUrlSource(auth.workspaceId, url);
      return context.json(result, 201);
    } catch (err) {
      if (err instanceof SensitiveSourceRejectedError) return context.json({ error_code: 'SENSITIVE_SOURCE_REJECTED', message: err.message }, 422);
      if (err instanceof SourceRejectedError) {
        const code = err.message.includes('拒绝访问') ? 'UNSAFE_URL'
          : err.message.includes('正文为空') ? 'UNSUPPORTED_URL_CONTENT'
          : 'UNSUPPORTED_SOURCE_FORMAT';
        return context.json({ error_code: code, message: err.message }, 422);
      }
      throw err;
    }
  }),
});
