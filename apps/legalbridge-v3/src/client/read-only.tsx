import { createContext, useContext } from "react";

/**
 * 読み取り専用で動いているか。
 *
 * 予備系（GCP が止まっているとき）は書き込みを止めて動かす。サーバは requireWritable で
 * 断るが、画面が今までどおり登録の欄を出していると、書いて押してから断られる。
 * 入れた内容も消える。押す前に分かるように、この値で欄ごと閉じる。
 */
export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);
