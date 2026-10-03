import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextRequest, NextResponse } from 'next/server';
import { getPublicAuthConfig, getServerSession } from '@/lib/server/auth';
import { getVideoAccessStorage } from '@/lib/server/video-access-runtime';
import { getRuntimeEnvValue } from '@/lib/server/runtime-env';
import { parseVideoAccessInput, readCloudflareIp } from '@/lib/server/video-access-log';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const respond = (error: string, status: number) => NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
  if (getRuntimeEnvValue('VIDEO_ACCESS_LOG_ENABLED', 'true') === 'false') return new NextResponse(null, { status: 204 });
  if (request.headers.get('origin') !== request.nextUrl.origin) return respond('Invalid origin', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return respond('JSON required', 415);
  if (Number(request.headers.get('content-length')) > 4096) return respond('Request too large', 413);

  try {
    const storage = getVideoAccessStorage();
    if (!storage) return respond('Video access storage is not configured', 503);
    const config = await getPublicAuthConfig();
    if (config.hasAuth && !await getServerSession(request)) return respond('Authentication required', 401);
    // Trust CF headers only inside the Cloudflare request runtime, never a public Node origin.
    if (!getOptionalRequestContext()) return respond('Cloudflare runtime required for visitor IP', 503);
    const ip = readCloudflareIp(request.headers);
    if (!ip) return respond('Visitor IP unavailable', 503);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 4096) return respond('Request too large', 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return respond('Invalid JSON', 400); }
    const input = parseVideoAccessInput(body);
    if (!input) return respond('Invalid video metadata', 400);
    const accepted = await storage.append({ ...input, ip, id: crypto.randomUUID(), playedAt: Date.now() });
    return accepted ? new NextResponse(null, { status: 204 }) : respond('Too many events', 429);
  } catch {
    return respond('Video access logging unavailable', 503);
  }
}
