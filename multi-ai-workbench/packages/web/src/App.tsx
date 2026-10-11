import { useEffect } from 'react';
import { ConcurrentPage } from './pages/ConcurrentPage';
import { ToastCenter } from './components/ToastCenter';
import { TopBar } from './components/TopBar';
import { initRealtime, useAppStore } from './store/appStore';

export default function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const stopAll = useAppStore((s) => s.stopAll);

  useEffect(() => {
    // 先建立实时连接，再拉取数据：避免首屏生成的事件全部丢失
    const ws = initRealtime();
    void bootstrap();
    return () => ws.destroy();
  }, [bootstrap]);

  useEffect(() => {
    // Esc = 停止当前会话所有正在生成的回复
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void stopAll();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stopAll]);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="min-h-0 flex-1 px-3 pb-3 pt-3 sm:px-4 sm:pb-4">
        <ConcurrentPage />
      </main>
      <ToastCenter />
    </div>
  );
}