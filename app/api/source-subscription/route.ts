import { getRuntimeEnvValue } from '@/lib/server/runtime-env';
import { readSourceSubscription } from '@/lib/server/source-subscription';

export const runtime = 'edge';

export function GET(request: Request) {
    const config = getRuntimeEnvValue('SUBSCRIPTION_SOURCES', process.env.SUBSCRIPTION_SOURCES || '') ||
        getRuntimeEnvValue('NEXT_PUBLIC_SUBSCRIPTION_SOURCES', process.env.NEXT_PUBLIC_SUBSCRIPTION_SOURCES || '');
    return readSourceSubscription(request, config);
}
