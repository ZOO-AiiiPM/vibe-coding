import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sidebar, type Zone } from './components/Sidebar';
import { TabBar, type Tab as TabPillModel } from './components/TabBar';
import { NoteList } from './components/NoteList';
import { NoteEditor } from './components/NoteEditor';
import { ClipInbox } from './components/ClipInbox';
import { ClipReader } from './components/ClipReader';
import { EmptyTabHome } from './components/EmptyTabHome';
import { SubscriptionLayout } from './components/SubscriptionLayout';
import { listNotes, getNote, createNote, updateNote, deleteNote } from './lib/db';
import { listClips, getClip, saveClip, deleteClip, updateClip } from './lib/db';
import { SearchOverlay } from './components/SearchOverlay';
import { useTheme } from './lib/useTheme';
import { cleanupOrphans } from './lib/attachments';
import type { Note, Clip } from './types';

const AIPanel = lazy(() =>
  import('./components/AIPanel').then(module => ({ default: module.AIPanel })),
);

type Tab = {
  id: string;
  zone: Zone | null;       // null = empty tab → 引导页
  refId: number | null;    // notes/clipping 时绑定的文档 id
  noteHistory: number[];   // 该 tab 的笔记浏览历史（id 序列），只 push 新切到的笔记
  noteHistoryIdx: number;  // 历史游标。-1 = 空。前进/后退时只动游标不 push
};

const PLACEHOLDER_LABEL: Record<Zone, string> = {
  subscribe: '订阅',
  notes: '笔记',
  clipping: '剪藏',
  sediment: '沉淀',
};

export default function App() {
  const { theme, toggle } = useTheme();
  const [notes, setNotes] = useState<Note[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMounted, setAiMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // ── 搜索弹窗 open/close（query/results 由 SearchOverlay 自管） ────────────
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);

  // ── Tab 状态机 ────────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'tab_1', zone: null, refId: null, noteHistory: [], noteHistoryIdx: -1 }]);
  const [activeTabId, setActiveTabId] = useState<string>('tab_1');
  const tabIdSeqRef = useRef(2);
  const loadingNoteIdsRef = useRef(new Set<number>());
  const loadingClipIdsRef = useRef(new Set<number>());

  const activeTab = useMemo(
    () => tabs.find(t => t.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );

  const updateActiveTab = useCallback(
    (patch: Partial<Omit<Tab, 'id'>>) => {
      setTabs(prev =>
        prev.map(t => (t.id === activeTabId ? { ...t, ...patch } : t))
      );
    },
    [activeTabId]
  );

  const addEmptyTab = useCallback(() => {
    const id = `tab_${tabIdSeqRef.current++}`;
    setTabs(prev => [...prev, { id, zone: null, refId: null, noteHistory: [], noteHistoryIdx: -1 }]);
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.id !== id);

      if (next.length === 0) {
        const newId = `tab_${tabIdSeqRef.current++}`;
        setActiveTabId(newId);
        return [{ id: newId, zone: null, refId: null, noteHistory: [], noteHistoryIdx: -1 }];
      }

      // 关掉的是 active：跳到右邻，无右则左邻
      if (id === activeTabId) {
        const neighbor = next[idx] ?? next[idx - 1] ?? next[0];
        setActiveTabId(neighbor.id);
      }
      return next;
    });
  }, [activeTabId]);

  // ── 数据加载 ──────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const list = await listNotes();
    setNotes(list);
    return list;
  }, []);

  const refreshClips = useCallback(async () => {
    const list = await listClips();
    setClips(list);
    return list;
  }, []);

  useEffect(() => {
    // notes + clips 必须都加载完再关 loading；否则 setLoading(false) 可能在 clips 还没回来时触发，
    // 用户立刻切到剪藏区会看到短暂"空白"。
    Promise.all([refresh(), refreshClips()])
      .then(() => {
        cleanupOrphans()
          .then(n => { if (n > 0) console.log(`[cleanup] removed ${n} orphan attachments`); })
          .catch(e => console.error('[cleanup] failed:', e));
      })
      .catch(e => console.error('[init] data load failed:', e))
      .finally(() => setLoading(false));
  }, [refresh, refreshClips]);

  const ensureNoteLoaded = useCallback(async (id: number) => {
    if (loadingNoteIdsRef.current.has(id)) return;
    const current = notes.find(n => n.id === id);
    if (!current || current.content_loaded) return;

    loadingNoteIdsRef.current.add(id);
    try {
      const full = await getNote(id);
      if (!full) return;
      setNotes(prev => prev.map(n => (n.id === id ? full : n)));
    } catch (e) {
      console.error('[notes] load failed:', e);
    } finally {
      loadingNoteIdsRef.current.delete(id);
    }
  }, [notes]);

  const ensureClipLoaded = useCallback(async (id: number) => {
    if (loadingClipIdsRef.current.has(id)) return;
    const current = clips.find(c => c.id === id);
    if (!current || current.content_loaded) return;

    loadingClipIdsRef.current.add(id);
    try {
      const full = await getClip(id);
      if (!full) return;
      setClips(prev => prev.map(c => (c.id === id ? full : c)));
    } catch (e) {
      console.error('[clips] load failed:', e);
    } finally {
      loadingClipIdsRef.current.delete(id);
    }
  }, [clips]);

  // ── AI 面板 ───────────────────────────────────────────────────────────────
  const toggleAI = useCallback(() => setAiOpen(prev => !prev), []);

  useEffect(() => {
    if (aiOpen) setAiMounted(true);
  }, [aiOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        toggleAI();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleAI]);

  // 搜索：debounce 200ms 调 search_all（已迁移到 SearchOverlay 内部，App 不再持有）
  // ⌘K 全局快捷键：唤起搜索弹窗
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOverlayOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── 笔记操作 ──────────────────────────────────────────────────────────────
  // 刚创建的笔记 id 标记：仅 NoteEditor 切到这条时触发 fade 动画，用完即清
  // （单纯靠"内容空"反推会误命中其他空笔记，必须显式信号）
  const [newlyCreatedNoteId, setNewlyCreatedNoteId] = useState<number | null>(null);
  const consumeNewlyCreated = useCallback(() => setNewlyCreatedNoteId(null), []);

  const handleCreateAndBind = useCallback(async () => {
    const id = await createNote();
    await refresh();
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== activeTabId) return t;
        // 新建笔记也算一次浏览：截断游标后内容、push 新 id、游标到末尾
        const newHist = [...t.noteHistory.slice(0, t.noteHistoryIdx + 1), id];
        return { ...t, zone: 'notes', refId: id, noteHistory: newHist, noteHistoryIdx: newHist.length - 1 };
      })
    );
    setNewlyCreatedNoteId(id);
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, content_md: '', content_loaded: true } : n)));
  }, [refresh, activeTabId]);

  const handleUpdateNote = useCallback(
    async (patch: { title?: string; content_md?: string }, targetNoteId?: number) => {
      // 切笔记的 race：NoteEditor 在切换前 flush 旧 note 的 pending 时显式传旧 id，
      // 避免 onChange 默认走 activeTab.refId（已是新 id）把内容写到新笔记
      const noteId = targetNoteId ?? (
        activeTab?.zone === 'notes' && activeTab.refId != null ? activeTab.refId : null
      );
      if (noteId == null) return;
      await updateNote(noteId, patch);
      setNotes(prev =>
        prev.map(n =>
          n.id === noteId
            ? {
                ...n,
                ...patch,
                content_loaded: n.content_loaded || patch.content_md !== undefined,
                updated_at: Math.floor(Date.now() / 1000),
              }
            : n
        )
      );
    },
    [activeTab]
  );

  const handleDeleteNote = useCallback(
    async (id: number) => {
      // 删除前 capture 邻接 id（按当前列表顺序——更新时间倒序）：
      // 优先下一项；如果删的是末尾就用上一项；列表只剩它自己 → null
      const oldIdx = notes.findIndex(n => n.id === id);
      const fallbackId =
        oldIdx === -1 ? null : (notes[oldIdx + 1]?.id ?? notes[oldIdx - 1]?.id ?? null);

      await deleteNote(id);
      const list = await refresh();
      // 防御：确认 fallback 还在新列表里
      const nextId = fallbackId != null && list.some(n => n.id === fallbackId) ? fallbackId : null;

      setTabs(prev =>
        prev.map(t => {
          if (!(t.zone === 'notes' && t.refId === id)) return t;
          if (nextId == null) return { ...t, refId: null };
          // 切到 nextId 同时入历史栈，保持后退可用
          const newHist = [...t.noteHistory.slice(0, t.noteHistoryIdx + 1), nextId];
          return { ...t, refId: nextId, noteHistory: newHist, noteHistoryIdx: newHist.length - 1 };
        })
      );
      cleanupOrphans().catch(e => console.error('[cleanup] failed:', e));
    },
    [notes, refresh]
  );

  // ── 剪藏操作 ──────────────────────────────────────────────────────────────
  type FetchedClip = {
    url: string; title: string; content_md: string;
    excerpt: string; site_name: string; favicon_url: string;
    cover_image: string; author: string; published_at: string;
    ip_region: string;
  };

  const handleClipSave = useCallback(async (url: string) => {
    const fetched = await invoke<FetchedClip>('fetch_clip', { url });
    const id = await saveClip(fetched);
    await refreshClips();
    setTabs(prev =>
      prev.map(t => (t.id === activeTabId ? { ...t, zone: 'clipping', refId: id } : t))
    );
  }, [refreshClips, activeTabId]);

  const handleClipDelete = useCallback(async (id: number) => {
    await deleteClip(id);
    await refreshClips();
    setTabs(prev =>
      prev.map(t =>
        t.zone === 'clipping' && t.refId === id ? { ...t, refId: null } : t
      )
    );
  }, [refreshClips]);

  const handleClipRefetch = useCallback(async (id: number, url: string) => {
    const fetched = await invoke<FetchedClip>('fetch_clip', { url });
    await updateClip(id, fetched);
    await refreshClips();
  }, [refreshClips]);

  // ── 派生：当前 tab 视图 ───────────────────────────────────────────────────
  const activeZone = activeTab?.zone ?? null;
  const selectedNote =
    activeTab?.zone === 'notes' && activeTab.refId != null
      ? notes.find(n => n.id === activeTab.refId) ?? null
      : null;
  const selectedClip =
    activeTab?.zone === 'clipping' && activeTab.refId != null
      ? clips.find(c => c.id === activeTab.refId) ?? null
      : null;
  const selectedNoteReady = selectedNote?.content_loaded ? selectedNote : null;
  const selectedClipReady = selectedClip?.content_loaded ? selectedClip : null;

  useEffect(() => {
    if (selectedNote && !selectedNote.content_loaded) {
      ensureNoteLoaded(selectedNote.id);
    }
  }, [selectedNote, ensureNoteLoaded]);

  useEffect(() => {
    if (selectedClip && !selectedClip.content_loaded) {
      ensureClipLoaded(selectedClip.id);
    }
  }, [selectedClip, ensureClipLoaded]);

  // 笔记浏览历史前进/后退是否可用（仅在 notes zone 有意义）
  const canBack = activeTab?.zone === 'notes' && (activeTab?.noteHistoryIdx ?? -1) > 0;
  const canForward = activeTab?.zone === 'notes' && (activeTab?.noteHistoryIdx ?? -1) < ((activeTab?.noteHistory.length ?? 0) - 1);

  const counts: Record<Zone, number> = {
    subscribe: 0,
    notes: notes.length,
    clipping: clips.length,
    sediment: 0,
  };

  // tab pill：title 实时从 notes/clips 派生
  const tabPills: TabPillModel[] = useMemo(() => {
    return tabs.map(t => {
      let title = '新建';
      if (t.zone === 'notes') {
        const n = t.refId != null ? notes.find(x => x.id === t.refId) : null;
        title = n ? (n.title || '无标题') : PLACEHOLDER_LABEL.notes;
      } else if (t.zone === 'clipping') {
        const c = t.refId != null ? clips.find(x => x.id === t.refId) : null;
        title = c ? (c.title || '无标题') : PLACEHOLDER_LABEL.clipping;
      } else if (t.zone === 'subscribe' || t.zone === 'sediment') {
        title = PLACEHOLDER_LABEL[t.zone];
      }
      return { id: t.id, title, zone: t.zone };
    });
  }, [tabs, notes, clips]);

  // ── 事件桥 ────────────────────────────────────────────────────────────────
  const handleSidebarSelect = useCallback((zone: Zone) => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== activeTabId) return t;
        // 切到 notes zone 时默认打开最新笔记（避免落到"选一条笔记"空白引导态）；
        // 这条笔记也算一次浏览，入历史栈让后退可用。其他 zone / 没有笔记时保持原行为。
        if (zone === 'notes' && notes.length > 0) {
          const id = notes[0].id;
          if (t.zone === 'notes' && t.refId === id) return t;
          const newHist = [...t.noteHistory.slice(0, t.noteHistoryIdx + 1), id];
          return { ...t, zone, refId: id, noteHistory: newHist, noteHistoryIdx: newHist.length - 1 };
        }
        return { ...t, zone, refId: null };
      })
    );
  }, [activeTabId, notes]);

  const handleEmptyPick = useCallback((zone: Zone) => {
    updateActiveTab({ zone, refId: null });
  }, [updateActiveTab]);

  const handleNoteSelect = useCallback((id: number) => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== activeTabId) return t;
        // 同一条笔记不重复入栈
        if (t.zone === 'notes' && t.refId === id) return t;
        const newHist = [...t.noteHistory.slice(0, t.noteHistoryIdx + 1), id];
        return { ...t, zone: 'notes', refId: id, noteHistory: newHist, noteHistoryIdx: newHist.length - 1 };
      })
    );
  }, [activeTabId]);

  const handleNoteBack = useCallback(() => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== activeTabId) return t;
        if (t.noteHistoryIdx <= 0) return t;
        const newIdx = t.noteHistoryIdx - 1;
        return { ...t, refId: t.noteHistory[newIdx], noteHistoryIdx: newIdx };
      })
    );
  }, [activeTabId]);

  const handleNoteForward = useCallback(() => {
    setTabs(prev =>
      prev.map(t => {
        if (t.id !== activeTabId) return t;
        if (t.noteHistoryIdx >= t.noteHistory.length - 1) return t;
        const newIdx = t.noteHistoryIdx + 1;
        return { ...t, refId: t.noteHistory[newIdx], noteHistoryIdx: newIdx };
      })
    );
  }, [activeTabId]);

  const handleClipSelect = useCallback((id: number) => {
    updateActiveTab({ zone: 'clipping', refId: id });
  }, [updateActiveTab]);

  // 剪藏列表上一条 / 下一条：clips 已按 saved_at desc，← 列表上面（更新）→ 列表下面（更早）
  const clipIdx = selectedClip ? clips.findIndex(c => c.id === selectedClip.id) : -1;
  const hasClipPrev = clipIdx > 0;
  const hasClipNext = clipIdx >= 0 && clipIdx < clips.length - 1;
  const clipPrev = useCallback(() => {
    if (clipIdx > 0) handleClipSelect(clips[clipIdx - 1].id);
  }, [clipIdx, clips, handleClipSelect]);
  const clipNext = useCallback(() => {
    if (clipIdx >= 0 && clipIdx < clips.length - 1) handleClipSelect(clips[clipIdx + 1].id);
  }, [clipIdx, clips, handleClipSelect]);

  // 进 clipping zone 且无选中 → 自动选第一条
  useEffect(() => {
    if (activeTab?.zone === 'clipping' && activeTab.refId == null && clips.length > 0) {
      handleClipSelect(clips[0].id);
    }
  }, [activeTab?.zone, activeTab?.refId, clips, handleClipSelect]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-stone-400 text-sm">
        加载中…
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden relative">
      <TabBar
        tabs={tabPills}
        activeId={activeTabId}
        onSelect={setActiveTabId}
        onClose={closeTab}
        onAddNew={addEmptyTab}
      />
      <div className="flex-1 flex overflow-hidden min-h-0">
        <Sidebar
          open={sidebarOpen}
          hidden={expanded}
          onToggle={() => setSidebarOpen(o => !o)}
          active={activeZone}
          onSelect={handleSidebarSelect}
          counts={counts}
          theme={theme}
          onToggleTheme={toggle}
          onSearchClick={() => setSearchOverlayOpen(true)}
        />

        {/* 主内容区：relative 是 AIPanel 的浮层定位锚点 */}
        <main className="flex-1 relative min-w-0">
          {/* Layer 2：Content card（list + main 合并的圆角白卡，右/下 flush window 边缘） */}
          <div className="h-full flex bg-white dark:bg-stone-900 rounded-tl-2xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.07),0_0_0_0.5px_rgba(0,0,0,0.05)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.4),0_0_0_0.5px_rgba(255,255,255,0.05)]">
            {activeZone === null ? (
              <EmptyTabHome onPick={handleEmptyPick} />
            ) : activeZone === 'clipping' ? (
              <>
                <ClipInbox
                  clips={clips}
                  selectedId={selectedClip?.id ?? null}
                  onSelect={handleClipSelect}
                  hidden={expanded}
                />
                <ClipReader
                  clip={selectedClipReady}
                  aiOpen={aiOpen}
                  onRefetch={handleClipRefetch}
                  onDelete={handleClipDelete}
                  onSave={handleClipSave}
                  onPrev={clipPrev}
                  onNext={clipNext}
                  hasPrev={hasClipPrev}
                  hasNext={hasClipNext}
                  expanded={expanded}
                  onExpand={() => setExpanded(e => !e)}
                />
              </>
            ) : activeZone === 'notes' ? (
              <>
                <NoteList
                  notes={notes}
                  selectedId={selectedNote?.id ?? null}
                  onSelect={handleNoteSelect}
                  onCreate={handleCreateAndBind}
                  onDelete={handleDeleteNote}
                  hidden={expanded}
                />
                <NoteEditor
                  note={selectedNoteReady}
                  onChange={handleUpdateNote}
                  theme={theme}
                  onDelete={() => selectedNote && handleDeleteNote(selectedNote.id)}
                  onCreate={handleCreateAndBind}
                  aiOpen={aiOpen}
                  expanded={expanded}
                  onExpand={() => setExpanded(e => !e)}
                  canBack={canBack}
                  canForward={canForward}
                  onBack={handleNoteBack}
                  onForward={handleNoteForward}
                  newlyCreatedId={newlyCreatedNoteId}
                  onCreateAnimDone={consumeNewlyCreated}
                />
              </>
            ) : activeZone === 'subscribe' ? (
              <SubscriptionLayout
                hidden={expanded}
                expanded={expanded}
                onExpand={() => setExpanded(e => !e)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-stone-400 dark:text-stone-500 text-sm">
                {PLACEHOLDER_LABEL[activeZone]} 敬请期待
              </div>
            )}
          </div>

          {/* Layer 3：AI 浮层（绝对定位浮在 content card 之上） */}
          {aiMounted && (
            <Suspense fallback={null}>
              <AIPanel
                open={aiOpen}
                currentNote={activeZone === 'notes' ? selectedNoteReady : null}
                currentClip={activeZone === 'clipping' ? selectedClipReady : null}
                zone={activeZone}
              />
            </Suspense>
          )}
        </main>
      </div>

      {/* 全局浮动 AI toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleAI();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="AI 助手 (⌘J)"
        className={`absolute top-1 right-2 z-50 w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
          aiOpen
            ? 'bg-black/[0.10] dark:bg-white/[0.12] text-stone-900 dark:text-stone-100'
            : 'text-stone-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2 14 8l6 2-6 2-2 6-2-6-6-2 6-2 2-6z" />
        </svg>
      </button>

      {/* 全局搜索浮层：searchOverlayOpen 控制 open/close */}
      <SearchOverlay
        open={searchOverlayOpen}
        notes={notes}
        clips={clips}
        onPickNote={(id) => {
          updateActiveTab({ zone: 'notes', refId: id });
          setSearchOverlayOpen(false);
        }}
        onPickClip={(id) => {
          updateActiveTab({ zone: 'clipping', refId: id });
          setSearchOverlayOpen(false);
        }}
        onClose={() => setSearchOverlayOpen(false)}
      />
    </div>
  );
}
