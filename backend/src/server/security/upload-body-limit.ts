import { bodyLimit } from 'hono/body-limit';

export const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024;
// multipart 的 boundary 与字段头也计入请求体，因此请求上限略高于文件上限。
export const MAX_UPLOAD_BODY_SIZE = MAX_UPLOAD_FILE_SIZE + 512 * 1024;

export const uploadBodyLimitMiddleware = bodyLimit({
  maxSize: MAX_UPLOAD_BODY_SIZE,
  onError: (context) => context.json(
    { message: '上传请求过大，单个文件不能超过 10 MB。' },
    413,
  ),
});
