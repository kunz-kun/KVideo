import { NextRequest, NextResponse } from 'next/server';
import { getServerSession, listAccountInfo } from '@/lib/server/auth';
import { getVideoAccessStorage } from '@/lib/server/video-access-runtime';
import { canReadVideoAccessLog, normalizeIp } from '@/lib/server/video-access-log';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' },
  });
  try {
    const session = await getServerSession(request);
    if (!session) return respond({ error: '请先登录管理员账号' }, 401);
    if (session.role !== 'admin' && session.role !== 'super_admin') return respond({ error: '仅管理员可查看' }, 403);
    // Re-read current role so removed/demoted accounts cannot reuse an old admin cookie.
    if (!canReadVideoAccessLog(session, await listAccountInfo(), Date.now())) return respond({ error: '管理员权限已失效，请重新登录' }, 403);
    const storage = getVideoAccessStorage();
    if (!storage) return respond({ error: '未绑定 D1 数据库 VIDEO_ACCESS_DB 或配置 Redis，无法保存或查看播放记录' }, 503);
    const ip = request.nextUrl.searchParams.get('ip')?.trim();
    if (ip && !normalizeIp(ip)) return respond({ error: '请输入完整的 IPv4 或 IPv6 地址' }, 400);
    const params = new URLSearchParams(request.nextUrl.searchParams);
    if (ip) params.set('ip', normalizeIp(ip)!);
    return respond(await storage.query(params, Date.now()));
  } catch {
    return respond({ error: '无法读取播放记录，请检查登录和数据库配置' }, 503);
  }
}
