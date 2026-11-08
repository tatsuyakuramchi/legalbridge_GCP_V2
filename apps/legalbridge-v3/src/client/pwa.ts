import { useEffect, useState } from "react";

/**
 * PWA の配線（public/sw.js・public/manifest.webmanifest。docs/v3-local-app-cloud-db.md §7）。
 *
 *   - service worker はビルドした版（本番・予備系）でだけ登録する。vite dev では登録しない
 *     （開発中に殻が残ると、直したのに古い画面が出て迷う）
 *   - 新しい版が入ったら知らせるだけで、勝手には入れ替えない（入力中の内容を消さないため）。
 *     人が「再読み込み」を押したら、待っている worker に替わってもらってから読み直す
 *   - 回線の有無（navigator.onLine）も一緒に返す。切れている間は画面の上に知らせる
 */
export interface PwaStatus {
  /** 新しい版の画面が入って、入れ替え待ち。 */
  updateReady: boolean;
  /** 回線がある（ブラウザの見立て）。 */
  online: boolean;
  /** ホーム画面・デスクトップから「アプリ」として開いている。 */
  standalone: boolean;
}

const isStandalone = () =>
  typeof window !== "undefined"
  && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);

let waitingWorker: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** 登録。ビルドした版でだけ。何度呼んでも 1 回しか登録しない。 */
let registered = false;
export function registerServiceWorker(): void {
  if (registered || typeof navigator === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  registered = true;
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    const track = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // 既に別の worker が画面を持っているときだけ「新しい版」。初回の登録は知らせない。
        if (worker.state === "installed" && navigator.serviceWorker.controller) { waitingWorker = worker; notify(); }
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) { waitingWorker = reg.waiting; notify(); }
    track(reg.installing);
    reg.addEventListener("updatefound", () => track(reg.installing));
    // 開きっぱなしの画面でも新しい版に気づけるように、戻ってきたときと 1 時間ごとに探す。
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => undefined); });
    setInterval(() => reg.update().catch(() => undefined), 60 * 60 * 1000);
  }).catch(() => undefined);
}

/** 「再読み込み」。待っている worker に替わってもらい、替わったら読み直す。 */
export function applyUpdate(): void {
  if (!waitingWorker) { window.location.reload(); return; }
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  waitingWorker = null;
}

export function usePwaStatus(): PwaStatus {
  const [updateReady, setUpdateReady] = useState(waitingWorker !== null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const onChange = () => setUpdateReady(waitingWorker !== null);
    listeners.add(onChange);
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { listeners.delete(onChange); window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return { updateReady, online, standalone: isStandalone() };
}
