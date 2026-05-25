import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Clip } from '../types';
import { sanitizeHtml } from '../lib/sanitizeHtml';

marked.use({ gfm: true, breaks: true });

type Props = {
  clip: Clip | null;
  aiOpen: boolean;
  onRefetch?: (id: number, url: string) => Promise<void>;
  onDelete?: (id: number) => void;
  onSave?: (url: string) => Promise<void>;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  expanded: boolean;
  onExpand: () => void;
};

/// 把发布时间字符串渲染成本地化日期+时刻。兼容三种输入：
/// - 纯数字（公众号 unix timestamp 秒）→ 按 unix 转 Date
/// - ISO 8601 / 其他 Date 可解析格式 → new Date 解析
/// - 解析失败 → 原样返回
function fmtPublished(s: string): string {
  if (!s) return '';
  const d = /^\d+$/.test(s)
    ? new Date(parseInt(s, 10) * 1000)
    : new Date(s);
  if (!d || Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

/// 判断颜色是否为"灰阶 / 接近灰阶"——红绿蓝三通道差异 < 30 即认定为黑白灰系。
/// 这种 inline color 在深色模式下应被剥掉让阅读器主题接管；高饱和度的装饰色
/// （绿/红/蓝/橙等）则保留作者意图。
function isNeutralColor(c: string): boolean {
  if (!c) return false;
  const m = c.match(/rgba?\((\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) {
    const channels = [+m[1], +m[2], +m[3]];
    return Math.max(...channels) - Math.min(...channels) < 30;
  }
  if (!c.startsWith('#')) return false;
  const hex = c.slice(1);
  const channels = hex.length === 3
    ? [hex[0] + hex[0], hex[1] + hex[1], hex[2] + hex[2]].map(v => parseInt(v, 16))
    : hex.length === 6
      ? [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(v => parseInt(v, 16))
      : null;
  if (!channels) return false;
  const [r, g, b] = channels;
  return Math.max(r, g, b) - Math.min(r, g, b) < 30;
}

/// 文本按行分割 → 去空 → 自动补 https://；保留原始行索引便于失败回填
function parseUrlLines(text: string): { url: string; raw: string }[] {
  return text.split(/[\n\r]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => ({
      raw: l,
      url: /^https?:\/\//i.test(l) ? l : 'https://' + l,
    }));
}

// 复用 NoteEditor 的 toolbar 按钮规范：w-8 h-8 + 18px icon + stroke-2 + stone-600,300
const BTN = "w-8 h-8 flex items-center justify-center rounded-md text-stone-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors";
const BTN_DISABLED = "w-8 h-8 flex items-center justify-center rounded-md text-stone-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 disabled:hover:bg-transparent disabled:text-stone-300 disabled:dark:text-stone-600 disabled:cursor-not-allowed transition-colors";
const BTN_DELETE = "w-8 h-8 flex items-center justify-center rounded-md text-stone-600 dark:text-stone-300 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 transition-colors";

export function ClipReader({
  clip, aiOpen, onRefetch, onDelete, onSave,
  onPrev, onNext, hasPrev = false, hasNext = false,
  expanded, onExpand,
}: Props) {
  const [refetching, setRefetching] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tbTitleRef = useRef<HTMLSpanElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);

  // 滚动后 toolbar 中央 fade-in 显示文章标题
  const [titleInToolbar, setTitleInToolbar] = useState(false);

  // 添加链接：toolbar 右组 ⊕ 控制
  const [addOpen, setAddOpen] = useState(false);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [batchInput, setBatchInput] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const batchUrls = useMemo(() => parseUrlLines(batchInput), [batchInput]);

  const contentHtml = useMemo(() => {
    if (!clip?.content_md) return '';
    return sanitizeHtml(marked.parse(clip.content_md) as string);
  }, [clip?.content_md]);

  // 深色模式下剥掉灰阶 inline color，保留彩色装饰；切主题或 DOM 重渲染时同步刷新。
  // ⚠️ 必须监听 contentRef 子树变化：React 在某些 re-render 时机会重设 dangerouslySetInnerHTML
  // 的 DOM 子树，覆盖我们改过的 inline style。subtree childList 监听到重设后立即 reapply。
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const apply = () => {
      const isDark = document.documentElement.classList.contains('dark');
      root.querySelectorAll<HTMLElement>('[style]').forEach(el => {
        if (el.dataset.origColor === undefined) {
          el.dataset.origColor = el.style.color || '';
        }
        const oc = el.dataset.origColor || '';
        if (!isDark) { el.style.color = oc; return; }
        el.style.color = isNeutralColor(oc) ? '' : oc;
      });
    };
    apply();
    // 监听 html.dark class 切换
    const themeObs = new MutationObserver(apply);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    // 监听 content div 子树变化（仅 childList，不监听 attributes 避免 apply 自己触发循环）
    const contentObs = new MutationObserver(apply);
    contentObs.observe(root, { childList: true, subtree: true });
    return () => {
      themeObs.disconnect();
      contentObs.disconnect();
    };
  }, [clip?.id]);

  // 监听 scroll 容器：H1 滚到 toolbar 下沿之上 → toolbar 显示标题
  // 用 h1 相对 scrollRef 顶部的距离，避免 main 不在 viewport 顶部时阈值算错
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) {
      setTitleInToolbar(false);
      return;
    }
    const onScroll = () => {
      const h1 = titleRef.current;
      if (!h1) { setTitleInToolbar(false); return; }
      const rootTop = root.getBoundingClientRect().top;
      const h1BottomRel = h1.getBoundingClientRect().bottom - rootTop;
      setTitleInToolbar(h1BottomRel < 56);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [clip?.id]);

  // 测量已不需要——改用 grid-cols-[1fr_auto] 让标题列自动占剩余空间，
  // mask-image 让超出部分从右往左渐隐，自然解决"装不下"的视觉问题
  // 保留 titleRef 用于 scroll 检测；不再测 fits

  const handleRefetch = async () => {
    if (!clip || !onRefetch || refetching) return;
    setRefetching(true);
    try {
      await onRefetch(clip.id, clip.url);
    } catch (e) {
      console.error('[refetch] failed:', e);
    } finally {
      setRefetching(false);
    }
  };

  const closeAdd = () => {
    if (adding) return;
    setAddOpen(false);
    setInput('');
    setBatchInput('');
    setBatchMode(false);
    setBatchErrors([]);
    setAddError('');
  };

  const handleAddSingle = async () => {
    let url = input.trim();
    if (!url || !onSave) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    setAdding(true);
    setAddError('');
    try {
      await onSave(url);
      setInput('');
      setAddOpen(false);
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleAddPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n') && parseUrlLines(text).length > 1) {
      e.preventDefault();
      setBatchMode(true);
      setBatchInput(text);
      setAddError('');
    }
  };

  const handleAddBatch = async () => {
    if (batchUrls.length === 0 || !onSave) return;
    setAdding(true);
    setBatchErrors([]);
    setProgress({ done: 0, total: batchUrls.length });
    const failedRaw: string[] = [];
    const errs: string[] = [];
    for (let i = 0; i < batchUrls.length; i++) {
      const { url, raw } = batchUrls[i];
      try { await onSave(url); }
      catch (e) {
        failedRaw.push(raw);
        errs.push(`${raw}: ${String(e)}`);
      }
      setProgress({ done: i + 1, total: batchUrls.length });
    }
    setAdding(false);
    setProgress(null);
    setBatchErrors(errs);
    setBatchInput(failedRaw.join('\n'));
    if (failedRaw.length === 0) {
      setBatchMode(false);
      setAddOpen(false);
    }
  };

  /// 顶栏 Toolbar：grid-cols-[1fr_auto]——左列标题占剩余空间 + mask-image 右边渐隐，
  /// 右列 icons 自动宽。撞 icons 不再发生（grid 自动给 icons 让位）。
  const Toolbar = (
    <div className={`absolute top-0 left-0 right-0 z-[5] h-12 grid grid-cols-[1fr_auto] items-center gap-3 pl-10 bg-white/95 dark:bg-stone-900/95 transition-[padding] duration-200 ease-out ${aiOpen ? 'pr-[323px]' : 'pr-3'}`}>
      {/* 标题列：mask 让超出右边的部分渐隐到透明 */}
      <div className="min-w-0 overflow-hidden">
        {clip && (
          <span
            ref={tbTitleRef}
            className={`block whitespace-nowrap text-[14px] font-bold text-stone-800 dark:text-stone-100 transition-opacity duration-200 ${
              titleInToolbar ? 'opacity-100' : 'opacity-0'
            }`}
            style={{
              maskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)',
              WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 32px), transparent)',
            }}
          >
            {clip.title || '无标题'}
          </span>
        )}
      </div>

      {/* icons 列 */}
      <div ref={iconsRef} className="flex items-center gap-0.5">
        <button onClick={onPrev} disabled={!hasPrev} title="上一条" className={BTN_DISABLED}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
        </button>
        <button onClick={onNext} disabled={!hasNext} title="下一条" className={BTN_DISABLED}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </button>
        {clip && (
          <>
            <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-1.5" />
            <button
              onClick={() => openUrl(clip.url).catch(e => console.error('[clip] open url failed:', e))}
              title="在浏览器中打开原文"
              className={BTN}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </button>
          </>
        )}
        {onSave && (
          <button
            onClick={() => addOpen ? closeAdd() : setAddOpen(true)}
            title={addOpen ? '收起（Esc）' : '添加链接'}
            className={BTN}
          >
            {addOpen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
          </button>
        )}
        {clip && onRefetch && (
          <button
            onClick={handleRefetch}
            disabled={refetching}
            title="重抓元数据"
            className={BTN_DISABLED}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              className={refetching ? 'animate-spin' : ''}>
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        )}
        <button onClick={onExpand} title={expanded ? '收起' : '专注模式'} className={BTN}>
          {expanded ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="10 5 10 10 5 10" />
              <line x1="10" y1="10" x2="3" y2="3" />
              <polyline points="14 19 14 14 19 14" />
              <line x1="14" y1="14" x2="21" y2="21" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 3 3 3 3 8" />
              <line x1="3" y1="3" x2="10" y2="10" />
              <polyline points="16 21 21 21 21 16" />
              <line x1="14" y1="14" x2="21" y2="21" />
            </svg>
          )}
        </button>
        {clip && onDelete && (
          <button
            onClick={() => {
              if (confirm(`删除「${clip.title || '无标题'}」？`)) onDelete(clip.id);
            }}
            title="删除剪藏"
            className={BTN_DELETE}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" x2="10" y1="11" y2="17" />
              <line x1="14" x2="14" y1="11" y2="17" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  /// 添加输入区——toolbar 下方 inline 展开
  const AddPanel = addOpen && onSave && (
    <div className="px-4 pb-3 border-b border-black/[0.05] dark:border-white/[0.05] shrink-0">
      {batchMode ? (
        <div className="space-y-1.5 max-w-2xl mx-auto">
          <div className="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400 px-0.5">
            <span>识别到 {batchUrls.length} 个链接</span>
            {!adding && (
              <button
                onClick={() => { setBatchMode(false); setBatchInput(''); setBatchErrors([]); }}
                className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors"
                title="切回单条"
              >
                单条
              </button>
            )}
          </div>
          <textarea
            value={batchInput}
            onChange={e => { setBatchInput(e.target.value); setBatchErrors([]); }}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleAddBatch();
              }
              if (e.key === 'Escape') closeAdd();
            }}
            placeholder="每行一个链接&#10;Cmd/Ctrl+Enter 提交"
            disabled={adding}
            rows={6}
            autoFocus
            className="w-full text-[12px] bg-black/[0.03] dark:bg-white/[0.04] border border-black/10 dark:border-white/10 rounded-lg px-2.5 py-1.5 outline-none text-stone-800 dark:text-stone-200 placeholder:text-stone-400 dark:placeholder:text-stone-600 disabled:opacity-50 resize-none font-mono leading-snug"
          />
          <button
            onClick={handleAddBatch}
            disabled={adding || batchUrls.length === 0}
            className="w-full text-[12px] py-1.5 rounded-lg bg-stone-900 dark:bg-stone-100 text-stone-50 dark:text-stone-900 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {adding && progress
              ? `添加中… ${progress.done}/${progress.total}`
              : `添加 ${batchUrls.length} 条`}
          </button>
          {batchErrors.length > 0 && (
            <div className="text-[11px] text-red-500 dark:text-red-400 leading-snug px-0.5 max-h-24 overflow-y-auto space-y-0.5">
              <div className="font-medium">{batchErrors.length} 条失败（已保留）：</div>
              {batchErrors.map((e, i) => (
                <div key={i} className="truncate" title={e}>· {e}</div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="max-w-2xl mx-auto">
          <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors ${
            addError
              ? 'border-red-400/60 bg-red-50/40 dark:bg-red-900/10'
              : 'border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04]'
          }`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              className="shrink-0 text-stone-400 dark:text-stone-500">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <input
              type="text"
              value={input}
              onChange={e => { setInput(e.target.value); setAddError(''); }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddSingle();
                if (e.key === 'Escape') closeAdd();
              }}
              onPaste={handleAddPaste}
              placeholder="粘贴链接 / Esc 取消 / 多行自动批量"
              disabled={adding}
              autoFocus
              className="flex-1 min-w-0 text-[12px] bg-transparent outline-none text-stone-800 dark:text-stone-200 placeholder:text-stone-400 dark:placeholder:text-stone-600 disabled:opacity-50"
            />
            {adding ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                className="shrink-0 text-stone-400 animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : input.trim() ? (
              <button onClick={handleAddSingle}
                className="shrink-0 text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-100 transition-colors">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            ) : null}
          </div>
          {addError && (
            <p className="mt-1 text-[11px] text-red-500 dark:text-red-400 leading-snug px-0.5">{addError}</p>
          )}
        </div>
      )}
    </div>
  );

  if (!clip) {
    return (
      <main className="relative flex-1 flex flex-col overflow-hidden">
        {Toolbar}
        <div className="pt-12 shrink-0">{AddPanel}</div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-stone-400 dark:text-stone-500 text-sm">
          <div className="text-2xl">📋</div>
          <div>点击右上角 ⊕ 添加第一条链接</div>
        </div>
      </main>
    );
  }

  const publishedText = fmtPublished(clip.published_at);

  return (
    <main className="relative flex-1 flex flex-col overflow-hidden">
      {Toolbar}
      <div className="pt-12 shrink-0">{AddPanel}</div>

      {/* 阅读内容 */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto transition-[padding] duration-200 ease-out ${aiOpen ? 'pr-[300px]' : ''} ${addOpen ? '' : '-mt-12 pt-12'}`}>
        <div className="max-w-2xl mx-auto px-10 pt-6 pb-16">
          <h1 ref={titleRef} className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-50 leading-tight mb-3">
            {clip.title || '无标题'}
          </h1>

          {(clip.author || clip.site_name || publishedText || clip.ip_region) && (
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[13px] text-stone-500 dark:text-stone-400 mb-5">
              {clip.author && (
                <span className="font-medium text-stone-700 dark:text-stone-300">{clip.author}</span>
              )}
              {clip.author && clip.site_name && clip.author !== clip.site_name && (
                <span className="text-stone-300 dark:text-stone-600">·</span>
              )}
              {clip.site_name && clip.author !== clip.site_name && (
                <span>{clip.site_name}</span>
              )}
              {(clip.author || clip.site_name) && publishedText && (
                <span className="text-stone-300 dark:text-stone-600">·</span>
              )}
              {publishedText && <span>{publishedText}</span>}
              {clip.ip_region && (
                <>
                  <span className="text-stone-300 dark:text-stone-600">·</span>
                  <span>{clip.ip_region}</span>
                </>
              )}
            </div>
          )}

          {contentHtml ? (
            <div
              ref={contentRef}
              className="clip-prose"
              dangerouslySetInnerHTML={{ __html: contentHtml }}
            />
          ) : (
            <div className="text-stone-400 dark:text-stone-500 text-sm italic">暂无正文内容</div>
          )}
        </div>
      </div>
    </main>
  );
}
