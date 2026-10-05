import { useEffect, useState } from "react";

/**
 * 時間のかかる操作の最中の印（メール送信の「送っています」と同じ形）。
 *
 * 決定は番号を振り、PDF を作って保存するので数秒〜十数秒かかることがある。ボタンが
 * 薄くなるだけだと「反応しない」と思われて押し直される。回る輪・何をしているか・経過秒を
 * 押したボタンのすぐ近くに出す。
 */
export function Working({ what, hint }: { what: string; hint?: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSec((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="sending" role="status" aria-live="polite">
      <span className="spin" />
      <span>
        <b>{what}</b>　{sec} 秒経過。{hint ? `${hint}。` : ""}しばらくお待ちください（二度押しは要りません）
      </span>
    </div>
  );
}
