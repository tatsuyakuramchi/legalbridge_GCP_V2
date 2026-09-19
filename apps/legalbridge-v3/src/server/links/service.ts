import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { RELATIONS, relationFor, type EntityKind, type LinkItem } from "./relations.js";

export interface RelationView {
  relation: string;
  label: string;
  target: EntityKind;
  single: boolean;
  editable: boolean;
  hint: string | null;
  items: LinkItem[];
}

/**
 * 関連の読み書き。どの画面からも同じ操作ができるようにするための1本。
 * 参照の向きはデータベースのまま。ここが変えるのは「どちらから触れるか」だけ。
 */
export class LinkService {
  constructor(private readonly database: Transactable) {}

  async view(kind: EntityKind, id: number): Promise<RelationView[]> {
    const group = RELATIONS[kind];
    if (!group) throw new DomainError("NOT_FOUND", `${kind} という種類はありません`);
    try {
      const out: RelationView[] = [];
      // 1本の接続に同時に問い合わせない。順に読む。
      for (const [relation, definition] of Object.entries(group)) {
        out.push({
          relation,
          label: definition.label,
          target: definition.target,
          single: definition.single,
          editable: definition.editable && Boolean(definition.attach),
          hint: definition.hint ?? null,
          items: await definition.list(this.database, id)
        });
      }
      return out;
    } catch (error) { throw translate(error); }
  }

  async candidates(
    kind: EntityKind, id: number, relation: string, keyword: string
  ): Promise<LinkItem[]> {
    const definition = relationFor(kind, relation);
    if (!definition.candidates) return [];
    try {
      return await definition.candidates(this.database, id, keyword);
    } catch (error) { throw translate(error); }
  }

  async attach(
    kind: EntityKind, id: number, relation: string, targetId: number, actor: string
  ): Promise<{ attached: true }> {
    const definition = relationFor(kind, relation);
    if (!definition.attach) {
      throw new DomainError("VALIDATION", `${definition.label}はここからは繋げません`);
    }
    try {
      return await inTransaction(this.database, async (client) => {
        // 1件だけ持てる関連は、付け替える前に外す。二重に持てない参照なので
        // 上書きになるが、記録には両方を残す。
        const before = definition.single ? await definition.list(client, id) : [];
        await definition.attach!(client, id, targetId);
        await recordAudit(client, {
          actor, action: `link.attach.${kind}.${relation}`, targetType: kind, targetId: id,
          detail: { relation, targetId, replaced: before.map((b) => b.id) }
        });
        return { attached: true as const };
      });
    } catch (error) { throw translate(error); }
  }

  async detach(
    kind: EntityKind, id: number, relation: string, targetId: number, actor: string
  ): Promise<{ detached: true }> {
    const definition = relationFor(kind, relation);
    if (!definition.detach) {
      throw new DomainError("VALIDATION", `${definition.label}はここからは外せません`);
    }
    try {
      return await inTransaction(this.database, async (client) => {
        await definition.detach!(client, id, targetId);
        await recordAudit(client, {
          actor, action: `link.detach.${kind}.${relation}`, targetType: kind, targetId: id,
          detail: { relation, targetId }
        });
        return { detached: true as const };
      });
    } catch (error) { throw translate(error); }
  }
}
