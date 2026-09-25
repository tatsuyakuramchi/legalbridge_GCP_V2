import { useEffect, useState } from "react";
import { api } from "./api.js";
import { SearchSelect } from "./SearchSelect.js";
import { WorkCreateForm } from "./WorkCreateForm.js";

/**
 * 作品を決める欄。探すか、無ければその場で登録する。
 *
 * ライセンスの案件は作品が軸で、条件（＝取引モデル）は作品にぶら下がる。
 * 作品が決まらないまま条件を作ると、権利の上限が計算できず、
 * 作品からも辿れない条件ができる。だから条件より先にここを通す。
 */
export interface WorkOption { id: number; title: string; workCode: string | null }

export function WorkChooser(
  { value, onChange, disabled }: {
    value: WorkOption | null;
    onChange: (work: WorkOption | null) => void;
    disabled?: boolean;
  }
) {
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [making, setMaking] = useState(false);

  function load(select?: number) {
    return api.get<{ works: WorkOption[] }>("/works")
      .then((r) => {
        setWorks(r.works);
        if (select) onChange(r.works.find((w) => w.id === select) ?? null);
      })
      .catch(() => undefined);
  }
  useEffect(() => { void load(); }, []);

  if (making) {
    return (
      <WorkCreateForm
        title="作品の登録"
        onDone={(created) => { setMaking(false); void load(created.id); }}
        onCancel={() => setMaking(false)} />
    );
  }

  return (
    <div className="row">
      <span className="faint">作品</span>
      <div style={{ minWidth: 260 }}>
        <SearchSelect
          value={value ? String(value.id) : ""}
          options={works.map((w) => ({ value: String(w.id), label: w.title, hint: w.workCode }))}
          emptyLabel="—" disabled={disabled}
          placeholder="作品名・作品コードで探す"
          onChange={(v) => onChange(works.find((w) => String(w.id) === v) ?? null)} />
      </div>
      <button className="btn btn-sm" disabled={disabled} onClick={() => setMaking(true)}>
        作品を登録する
      </button>
    </div>
  );
}
