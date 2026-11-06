import { createContext, useContext } from "react";
import type { SettlementSource } from "./OrderSettlement.js";

/**
 * マップ（工程表）から次の文書・関係する画面へ行く道（App が配る）。
 *
 * 工程表は案件・作品・作業台の 3 か所で使うので、行き先をそれぞれの画面に props で通さず、
 * ここで受け取る。配られていなければボタンを出さない。
 *   settle   … 発注書・単体契約 → 検収書・役務提供完了通知書（支払文書 › 発注書から検収書）
 *   royalty  … 利用許諾条件書 → 利用許諾計算書（作品 › 利用許諾計算の台帳。作家 × 作品）
 *   agreement… 基本契約・単体契約の画面
 */
export interface MapLinks {
  settle?: (source: SettlementSource) => void;
  royalty?: (target: { partyId: number; workId: number | null }) => void;
  agreement?: (agreementId: number) => void;
}

export const MapLinksContext = createContext<MapLinks>({});
export const useMapLinks = () => useContext(MapLinksContext);
