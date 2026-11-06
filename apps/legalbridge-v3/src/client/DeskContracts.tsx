import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { PartyMapView } from "./AgreementMapWorkspace.js";
import { AgreementCreate, type CreatePreset } from "./AgreementsWorkspace.js";
import { DocumentImport } from "./DocumentImport.js";
import type { EntityKind } from "./Relations.js";
import type { PartyMap } from "../server/agreements/party-map.js";

/**
 * 作業台の「契約・文書」（docs/desk-home.md §5）。取引先 1 社の契約を、作業台の中で管理する。
 *
 *   - 基本契約・単体契約の登録（番号を取る。まだ締結していなければ交渉中で番号だけ）
 *   - 基本契約の下に個別契約を足す（親の番号＋枝番）
 *   - 契約ごとの「文書」で PDF を登録し、そのままクラウドサインで送る（取り込みの欄）
 *   - 文書を探して契約に登録・送る、契約ごとに送る（取引先⇔基本契約の画面と同じ部品）
 *
 * 図と部品は取引先⇔基本契約の画面（AgreementMapWorkspace の PartyMapView）をそのまま使う。
 * 読むのはこのタブを開いたときの 1 本（/agreement-map/parties/:id）だけ。
 */
export function DeskContracts({ partyId, onOpen, onOpenDocument, onChanged }: {
  partyId: number;
  onOpen: (kind: EntityKind, id: number) => void;
  onOpenDocument: (id: number) => void;
  /** 契約・文書を足した・直したとき（ツリーの件数と工程表を読み直す）。 */
  onChanged: () => void;
}) {
  const [map, setMap] = useState<PartyMap | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 開いている登録欄（契約・個別契約）。 */
  const [creating, setCreating] = useState<CreatePreset | null>(null);
  /** 登録した直後の契約。続けて契約書（PDF）を登録してクラウドサインへ進む欄を出す。 */
  const [made, setMade] = useState<{ id: number; agreementNo: string | null } | null>(null);

  useEffect(() => {
    setError(null);
    api.get<PartyMap>(`/agreement-map/parties/${partyId}`)
      .then(setMap).catch((e: ApiError) => setError(e.message));
  }, [partyId, version]);

  const changed = (msg: string) => { setNotice(msg); setError(null); setVersion((v) => v + 1); onChanged(); };
  const open = (kind: EntityKind, id: number) => (kind === "document" ? onOpenDocument(id) : onOpen(kind, id));

  if (!map) return error ? <div className="alert">{error}</div> : <div className="faint">読み込み中…</div>;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-sm primary" onClick={() => { setCreating({ partyId: map.party.id, partyName: map.party.name }); setMade(null); }}>
          ＋ 契約を登録（番号を取る）
        </button>
        <span className="faint">
          基本契約・単体契約・NDA など。まだ締結していなければ「まだ締結していない」で番号だけ取れます。
          個別契約は基本契約の行の「＋ 個別契約」、契約書の PDF は契約の行の「文書」から登録してクラウドサインで送ります
        </span>
      </div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      {creating && (
        <AgreementCreate key={`${creating.kind ?? ""}${creating.parentId ?? ""}`} preset={creating}
          onCancel={() => setCreating(null)}
          onDone={(id, agreementNo) => {
            setCreating(null);
            setMade({ id, agreementNo });
            changed(`契約 ${agreementNo ?? `#${id}`} を登録しました`);
          }} />
      )}

      {made && (
        <div className="panel">
          <div className="panel-hd">
            <h2>{made.agreementNo ?? `#${made.id}`} の契約書を登録する</h2>
            <span className="faint">PDF を登録すると、そのままクラウドサインの署名者を入れる画面に進めます</span>
            <span style={{ marginLeft: "auto" }} />
            <button className="linky" onClick={() => onOpen("agreement", made.id)}>条件明細を入れる（契約の画面）</button>
            <button className="btn btn-sm" onClick={() => setMade(null)}>閉じる</button>
          </div>
          <div className="panel-bd">
            <DocumentImport key={made.id} agreementId={made.id} initialMode="import"
              onOpenDocument={onOpenDocument}
              onDone={() => { setMade(null); changed(`${made.agreementNo ?? `#${made.id}`} に契約書を登録しました`); }} />
          </div>
        </div>
      )}

      <PartyMapView map={map} sendVersion={version} onOpen={open}
        onRegisterAgreement={(id, name) => { setCreating({ partyId: id, partyName: name }); setMade(null); }}
        onAddSupplement={(parent) => {
          setCreating({ partyId: map.party.id, partyName: map.party.name, kind: "supplement", parentId: parent.id, domain: parent.domain ?? undefined });
          setMade(null);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        onChanged={changed} onError={(m) => { setError(m); setNotice(null); }} />
    </div>
  );
}
