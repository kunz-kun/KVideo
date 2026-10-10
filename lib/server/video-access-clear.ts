import type { AccountInfo, ServerAuthSession } from './auth';
import type { VideoAccessStorage } from './video-access-storage';
import { canReadVideoAccessLog } from './video-access-log';

interface ClearDependencies {
  getSession(): Promise<ServerAuthSession | null>;
  listAccounts(): Promise<AccountInfo[]>;
  getStorage(): VideoAccessStorage | null;
}

export async function clearVideoAccessRecords(request: Request, dependencies: ClearDependencies): Promise<Response> {
  const respond = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' },
  });
  try {
    const session = await dependencies.getSession();
    if (!session) return respond({ error: '请先登录管理员账号' }, 401);
    if (!canReadVideoAccessLog(session, await dependencies.listAccounts(), Date.now())) {
      return respond({ error: '仅当前有效的管理员可清空记录，请检查权限或重新登录' }, 403);
    }
    // Require a same-origin request and an explicit intent header to prevent CSRF.
    if (request.headers.get('origin') !== new URL(request.url).origin ||
        request.headers.get('X-KVideo-Clear-Logs') !== 'all') {
      return respond({ error: '无效的清空请求' }, 403);
    }
    const storage = dependencies.getStorage();
    if (!storage) return respond({ error: '未配置播放记录数据库，无法清空' }, 503);
    await storage.clear();
    return respond({ cleared: true });
  } catch {
    return respond({ error: '清空失败，请稍后重试' }, 503);
  }
}
