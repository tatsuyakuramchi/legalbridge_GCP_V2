import { useEffect, useState } from "react";
import { api } from "./api.js";
import { SearchSelect, staffOptions } from "./SearchSelect.js";

/**
 * 作る文書の担当者を選ぶ欄（manual_inputs._ownerStaffId）。まとめて締める・計算書の一括の出し直しで使う。
 * 計算書は「担当」に部署・名前・メール・電話が出る。選ばなければ案件の担当（無ければ事業名）。
 */
export function OwnerStaffPicker({ value, onChange, emptyLabel, disabled }: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** 選ばないときの意味（「選ばない（案件の担当）」など）。 */
  emptyLabel: string;
  disabled?: boolean;
}) {
  const [staff, setStaff] = useState<Array<{ id: number; name: string; department?: string | null; status?: string }>>([]);
  useEffect(() => {
    let live = true;
    api.get<{ staff: typeof staff }>("/staff").then((r) => { if (live) setStaff(r.staff); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return (
    <SearchSelect value={value ? String(value) : ""} options={staffOptions(staff)} emptyLabel={emptyLabel}
      valueLabel={value ? staff.find((s) => s.id === value)?.name ?? null : emptyLabel}
      placeholder="氏名・部署で探す" disabled={disabled}
      onChange={(v) => onChange(v ? Number(v) : null)} />
  );
}
