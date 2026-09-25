import { CreateForm, int, text } from "./CreateForm.js";

/**
 * 作品の登録フォーム。
 *
 * 作品の画面と、ライセンス案件の条件タブの両方から使う。ライセンスは作品が
 * 軸なので、条件を立てる前に作品が要る。ここが作品の画面にしか無かったころは
 * 「作品の画面で登録してから案件に戻る」往復が要った。
 */
export function WorkCreateForm(
  { title = "作品の登録", onDone, onCancel }: {
    title?: string;
    onDone: (created: { id: number; title?: string }) => void;
    onCancel: () => void;
  }
) {
  return (
    <CreateForm
      title={title}
      path="/works"
      initial={{ kind: "own", status: "planning" }}
      fields={[
        { name: "title", label: "作品名", required: true },
        { name: "titleKana", label: "カナ" },
        { name: "kind", label: "種別", type: "select", required: true,
          options: [{ value: "own", label: "自社作品" }, { value: "source_ip", label: "原作IP" },
                    { value: "derivative", label: "派生作品" }] },
        { name: "status", label: "状態", type: "select", required: true,
          options: [{ value: "planning", label: "企画中" }, { value: "in_production", label: "制作中" },
                    { value: "released", label: "発売済" }, { value: "archived", label: "終了" }] },
        { name: "businessLine", label: "事業区分" },
        { name: "parentWorkId", label: "親作品ID", type: "number",
          visibleWhen: (v) => v.kind === "derivative",
          hint: "指定すると系譜に登録する" },
        { name: "remarks", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => ({
        title: text(v.title), titleKana: text(v.titleKana), kind: v.kind, status: v.status,
        businessLine: text(v.businessLine), parentWorkId: int(v.parentWorkId), remarks: text(v.remarks)
      })}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
