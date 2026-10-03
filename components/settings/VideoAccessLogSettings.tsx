'use client';

import { useEffect, useState } from 'react';
import { getSession } from '@/lib/store/auth-store';
import type { VideoAccessRecord } from '@/lib/server/video-access-log';
import { SettingsSection } from './SettingsSection';

interface LogPage { records: VideoAccessRecord[]; total: number; page: number; pageSize: number }

export function VideoAccessLogSettings() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const update = () => {
      const role = getSession()?.role;
      setAllowed(role === 'admin' || role === 'super_admin');
    };
    update();
    window.addEventListener('kvideo-session-changed', update);
    return () => window.removeEventListener('kvideo-session-changed', update);
  }, []);
  return allowed ? <VideoAccessLogPanel /> : null;
}

function VideoAccessLogPanel() {
  const [ip, setIp] = useState('');
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState({ ip: '', title: '', page: 1, revision: 0 });
  const [data, setData] = useState<LogPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const params = new URLSearchParams({ ip: query.ip, title: query.title, page: String(query.page) });
    void fetch(`/api/admin/video-access?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '读取失败');
        if (active) setData(body);
      }).catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : '读取失败');
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query]);

  const load = (page: number, applyFilters = false) => {
    setLoading(true); setError(''); setData(null);
    setQuery(previous => ({ ip: applyFilters ? ip : previous.ip, title: applyFilters ? title : previous.title, page, revision: previous.revision + 1 }));
  };
  const inputClass = 'rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] p-2 text-[var(--text-color)]';
  const buttonClass = 'rounded-lg border border-[var(--glass-border)] px-4 py-2 disabled:opacity-50';

  return (
    <SettingsSection title="视频播放记录" description="仅管理员可查看。记录视频实际开始播放时的 IP、片名、集数、来源及时间；暂停后继续播放不会重复记录。不表示已看完。保留最近 30 天，最多 10,000 条。">
      <form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); load(1, true); }}>
        <label className="flex flex-col gap-1">IP 地址<input className={inputClass} value={ip} onChange={event => setIp(event.target.value)} placeholder="完整 IPv4 / IPv6" maxLength={64} /></label>
        <label className="flex flex-col gap-1">片名<input className={inputClass} value={title} onChange={event => setTitle(event.target.value)} placeholder="片名关键词" maxLength={200} /></label>
        <button className={`${buttonClass} self-end`} type="submit" disabled={loading}>查询 / 刷新</button>
      </form>
      {error ? <p role="alert" className="mt-4 text-red-500">{error}</p> : null}
      <div role="status" className="mt-4 text-sm">{loading ? '正在读取…' : data ? `共 ${data.total} 条记录` : ''}</div>
      {data ? <>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">视频播放记录（按时间从新到旧）</caption>
            <thead><tr>{['时间', 'IP', '片名', '集数', '来源'].map(label => <th key={label} scope="col" className="p-2 whitespace-nowrap">{label}</th>)}</tr></thead>
            <tbody>{data.records.map(record => <tr key={record.id} className="border-t border-[var(--glass-border)]">
              <td className="p-2 whitespace-nowrap">{new Date(record.playedAt).toLocaleString('zh-CN')}</td>
              <td className="p-2 font-mono whitespace-nowrap">{record.ip}</td><td className="p-2">{record.title}</td>
              <td className="p-2">{record.episodeName || `第 ${record.episodeIndex + 1} 集`}</td>
              <td className="p-2">{record.source}{record.premium ? '（高级）' : ''}</td>
            </tr>)}</tbody>
          </table>
          {data.records.length === 0 ? <p className="p-4">暂无记录。功能上线后有用户实际开始播放视频时才会产生记录。</p> : null}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button className={buttonClass} disabled={loading || query.page <= 1} onClick={() => load(query.page - 1)}>上一页</button>
          <span>第 {query.page} 页</span>
          <button className={buttonClass} disabled={loading || query.page * data.pageSize >= data.total} onClick={() => load(query.page + 1)}>下一页</button>
        </div>
      </> : null}
    </SettingsSection>
  );
}
