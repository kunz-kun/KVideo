'use client';

import { Button } from '@/components/ui/Button';
import { Icons } from '@/components/ui/Icon';

interface NoResultsProps {
  onReset: () => void;
  error?: string | null;
  onRetry?: () => void;
}

export function NoResults({ onReset, error, onRetry }: NoResultsProps) {
  return (
    <div className="text-center py-20 animate-fade-in" role={error ? 'alert' : 'status'}>
      <div 
        className="inline-flex items-center justify-center w-32 h-32 bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--glass-border)] mb-6 rounded-[var(--radius-full)]" 
      >
        <Icons.Search size={64} className="text-[var(--text-color-secondary)]" />
      </div>
      <h3 className="text-3xl font-bold text-[var(--text-color)] mb-4">
        {error ? '搜索暂时无法完成' : '未找到相关内容'}
      </h3>
      <p className="text-lg text-[var(--text-color-secondary)] mb-6">
        {error || '试试其他关键词或检查拼写'}
      </p>
      {error && onRetry && <Button variant="primary" onClick={onRetry} className="mb-3 mx-2">重试搜索</Button>}
      <Button variant={error ? 'secondary' : 'primary'} onClick={onReset}>
        返回首页
      </Button>
    </div>
  );
}
